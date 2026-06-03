/*
 * MIT License
 *
 * Copyright (c) 2026 Tingyang Zhang
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {
    createChatChannelPlugin
} from "openclaw/plugin-sdk/core";
import type {OpenClawConfig} from "openclaw/plugin-sdk/core";
import {dispatchInboundDirectDmWithRuntime} from "openclaw/plugin-sdk/channel-inbound";
import {waitUntilAbort} from "openclaw/plugin-sdk/channel-lifecycle";
import {WsChannel} from "./ws-channel.js";

type DispatchDirectDmRuntime = Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["runtime"];

// 当前频道 ID（在 OpenClaw 内部用于唯一标识该渠道）
const channelId = "wechat-mpc";
// 当前频道的展示元信息（用于管理界面展示与渠道类型区分）
const channelMeta = {
    "id": "wechat-mpc",
    "label": "WeChatMP-ThirdParty",
    "selectionLabel": "WeChat MP (Third-party Platform)",
    "docsPath": "/channels/wechat-mpc",
    "docsLabel": "wechat-mpc",
    "blurb": "Third-party platform-based OpenClaw WeChat Official Account (微信公众号) channel plugin.",
}

// 解析后的账号信息结构（来自配置文件）
type ResolvedAccount = {
    accountId: string | null,
    proxyUrl: string;
    appid: string;
    apiKey: string;
};

// 每个账号维持一个独立 WebSocket 连接实例
const accountChannels = new Map<string, WsChannel>();

// 同一发送者最多允许排队的入站任务数，超过后丢弃，防止单会话无限堆积。
const MAX_SENDER_QUEUE_DEPTH = 10;
// 单条入站派发任务超时时间（毫秒）；超时后触发熔断。
const SENDER_DISPATCH_TIMEOUT_MS = 60000;
// 熔断冷却时间（毫秒）；冷却期内新消息直接丢弃。
const SENDER_BREAKER_COOLDOWN_MS = 10000;
// 出站缓冲区上限；连接抖动时先入队，重连后再发送。
const MAX_OUTBOUND_QUEUE_SIZE = 200;
// 出站补发重试间隔（毫秒）。
const OUTBOUND_FLUSH_RETRY_MS = 1500;

type OutboundQueueItem = {
    appid: string;
    to: string;
    text: string;
    source: "gateway" | "deliver";
    traceId?: string;
    enqueuedAt: number;
};

// 每个账号一个出站消息缓冲队列（断线重连期间暂存）。
const outboundQueues = new Map<string, OutboundQueueItem[]>();
// 每个账号一个出站补发定时器。
const outboundFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
// 防止同账号并发 flush 造成乱序和重复发送。
const outboundFlushing = new Set<string>();

// 每个发送者（accountKey:senderId）维持一个串行派发队列。
// 确保同一会话的多条入站消息按顺序逐一投入 OpenClaw SDK，
// 避免 SDK 在"同会话并发"时跳过前一条消息的 deliver 回调。
const senderDispatchQueues = new Map<string, Promise<void>>();
const senderDispatchDepths = new Map<string, number>();
const senderBreakerOpenUntil = new Map<string, number>();

type SenderDispatchTaskError = Error & {
    code?: string;
};

/** 判断 sender 队列是否处于熔断冷却期。 */
function isSenderBreakerOpen(queueKey: string): boolean {
    const openUntil = senderBreakerOpenUntil.get(queueKey);
    if (!openUntil) {
        return false;
    }
    if (Date.now() >= openUntil) {
        senderBreakerOpenUntil.delete(queueKey);
        return false;
    }
    return true;
}

/** 打开 sender 队列熔断窗口，阻止后续任务继续入队。 */
function tripSenderBreaker(queueKey: string, reason: string): void {
    const openUntil = Date.now() + SENDER_BREAKER_COOLDOWN_MS;
    senderBreakerOpenUntil.set(queueKey, openUntil);
    console.warn(`${channelId}, senderDispatchQueue breaker open`, {
        queueKey,
        reason,
        openUntil,
    });
}

/** 识别是否为入站派发超时错误。 */
function isSenderDispatchTimeoutError(err: unknown): err is SenderDispatchTaskError {
    return Boolean(
        err &&
        typeof err === "object" &&
        (err as SenderDispatchTaskError).code === "SENDER_DISPATCH_TIMEOUT"
    );
}

/** 为单条 sender 入站任务套上超时保护，超时则抛错交由上层熔断。 */
function runSenderDispatchTaskWithTimeout(queueKey: string, task: () => Promise<unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const timeoutError = new Error(`sender dispatch timeout key=${queueKey}`) as SenderDispatchTaskError;
            timeoutError.code = "SENDER_DISPATCH_TIMEOUT";
            reject(timeoutError);
        }, SENDER_DISPATCH_TIMEOUT_MS);

        Promise.resolve()
            .then(() => task())
            .then(() => resolve())
            .catch((err) => reject(err))
            .finally(() => clearTimeout(timer));
    });
}

/** 清理账号的出站补发定时器。 */
function clearOutboundFlushTimer(accountKey: string): void {
    const timer = outboundFlushTimers.get(accountKey);
    if (timer) {
        clearTimeout(timer);
        outboundFlushTimers.delete(accountKey);
    }
}

/** 为账号安排一次延时补发，避免并发创建多个 flush 计时器。 */
function scheduleOutboundFlush(accountKey: string, account: ResolvedAccount, delayMs: number = OUTBOUND_FLUSH_RETRY_MS): void {
    if (!outboundQueues.get(accountKey)?.length) {
        return;
    }
    clearOutboundFlushTimer(accountKey);
    const timer = setTimeout(() => flushOutboundQueue(accountKey, account), delayMs);
    outboundFlushTimers.set(accountKey, timer);
}

/** 尝试直接通过当前活跃 WebSocket 发送单条出站消息。 */
function trySendOutboundItem(accountKey: string, item: OutboundQueueItem): boolean {
    const channel = accountChannels.get(accountKey);
    return channel?.send("msg", `text ${item.appid} ${item.to} ${item.text}`) ?? false;
}

/** 按顺序补发账号出站队列；发送失败时保留队列并重试。 */
function flushOutboundQueue(accountKey: string, account: ResolvedAccount): void {
    if (outboundFlushing.has(accountKey)) {
        return;
    }

    const queue = outboundQueues.get(accountKey);
    if (!queue || queue.length === 0) {
        clearOutboundFlushTimer(accountKey);
        outboundQueues.delete(accountKey);
        return;
    }

    outboundFlushing.add(accountKey);
    try {
        while (queue.length > 0) {
            const head = queue[0];
            const sent = trySendOutboundItem(accountKey, head);
            if (!sent) {
                scheduleOutboundFlush(accountKey, account);
                return;
            }
            queue.shift();
        }

        clearOutboundFlushTimer(accountKey);
        outboundQueues.delete(accountKey);
    } finally {
        outboundFlushing.delete(accountKey);
    }
}

/** 向账号出站队列追加消息，并在超限时淘汰最老消息。 */
function queueOutboundItem(accountKey: string, item: OutboundQueueItem): void {
    const queue = outboundQueues.get(accountKey) ?? [];
    if (queue.length >= MAX_OUTBOUND_QUEUE_SIZE) {
        const dropped = queue.shift();
        console.warn(`${channelId}, outbound queue full, drop oldest`, {
            accountKey,
            droppedAt: dropped?.enqueuedAt,
            source: dropped?.source,
            traceId: dropped?.traceId,
        });
    }
    queue.push(item);
    outboundQueues.set(accountKey, queue);
}

/** 出站统一入口：优先直发，失败后入队等待重连补发。 */
function sendOrQueueOutboundText(params: {
    account: ResolvedAccount;
    accountKey: string;
    to: string;
    text: string;
    source: "gateway" | "deliver";
    traceId?: string;
}): { sent: boolean; queued: boolean } {
    const item: OutboundQueueItem = {
        appid: params.account.appid,
        to: params.to,
        text: params.text,
        source: params.source,
        traceId: params.traceId,
        enqueuedAt: Date.now(),
    };

    if (trySendOutboundItem(params.accountKey, item)) {
        return {sent: true, queued: false};
    }

    queueOutboundItem(params.accountKey, item);
    scheduleOutboundFlush(params.accountKey, params.account);
    return {sent: false, queued: true};
}

/** 清理账号级并发状态（出站队列、定时器、入站队列与熔断状态）。 */
function cleanupAccountQueues(accountKey: string): void {
    clearOutboundFlushTimer(accountKey);
    outboundQueues.delete(accountKey);
    outboundFlushing.delete(accountKey);

    // 清理该账号下所有 sender 串行队列状态，避免停账号后残留内存。
    const prefix = `${accountKey}:`;
    for (const key of senderDispatchQueues.keys()) {
        if (key.startsWith(prefix)) {
            senderDispatchQueues.delete(key);
            senderDispatchDepths.delete(key);
            senderBreakerOpenUntil.delete(key);
        }
    }
}

/**
 * sender 入站串行队列入口：
 * - 同 sender 严格串行
 * - 队列深度上限
 * - 单任务超时熔断
 */
function enqueueSenderDispatch(queueKey: string, task: () => Promise<unknown>): boolean {
    if (isSenderBreakerOpen(queueKey)) {
        console.warn(`${channelId}, senderDispatchQueue breaker open, drop message`, {queueKey});
        return false;
    }

    const depth = (senderDispatchDepths.get(queueKey) ?? 0) + 1;
    if (depth > MAX_SENDER_QUEUE_DEPTH) {
        console.warn(`${channelId}, senderDispatchQueue overflow, drop message`, {
            queueKey,
            depth,
            maxDepth: MAX_SENDER_QUEUE_DEPTH,
        });
        tripSenderBreaker(queueKey, "queue_overflow");
        return false;
    }
    senderDispatchDepths.set(queueKey, depth);

    const prev = senderDispatchQueues.get(queueKey) ?? Promise.resolve();
    const next = prev
        .then(() => {
            if (isSenderBreakerOpen(queueKey)) {
                throw new Error(`sender breaker open key=${queueKey}`);
            }
            return runSenderDispatchTaskWithTimeout(queueKey, task);
        })
        .catch((err) => {
            if (isSenderDispatchTimeoutError(err)) {
                tripSenderBreaker(queueKey, "dispatch_timeout");
            }
            console.warn(`${channelId}, senderDispatchQueue task error, key=${queueKey}`, err);
        })
        .then(() => {
            const currentDepth = senderDispatchDepths.get(queueKey) ?? 1;
            if (currentDepth <= 1) {
                senderDispatchDepths.delete(queueKey);
            } else {
                senderDispatchDepths.set(queueKey, currentDepth - 1);
            }
            // 队列为空时清理，防止内存泄漏
            if (senderDispatchQueues.get(queueKey) === next) {
                senderDispatchQueues.delete(queueKey);
            }
        });
    senderDispatchQueues.set(queueKey, next);
    return true;
}

// 从消息对象中提取图片 URL 列表，供模型输入使用
function extractImageUrls(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((url) => Boolean(url));
}

// Simple safety gate: block messages that start with emoji-like symbols.
function startsWithEmojiPrefix(text: string): boolean {
    const normalized = text.trimStart();
    if (!normalized) {
        return false;
    }
    const firstCodePoint = normalized.codePointAt(0);
    if (firstCodePoint === undefined) {
        return false;
    }
    return (
        (firstCodePoint >= 0x1F300 && firstCodePoint <= 0x1FAFF) ||
        (firstCodePoint >= 0x2600 && firstCodePoint <= 0x27BF)
    );
}

// 生成账号唯一键：accountId + appid，避免多账号场景下串连
function getAccountKey(account: ResolvedAccount): string {
    return `${account.accountId ?? "default"}:${account.appid}`;
}

// 从全局配置中解析账号信息，供启动时使用
function resolveAccountFromConfig(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
    const section = (cfg.channels as Record<string, any>)?.[channelId];
    const proxyUrl = section?.proxyUrl;
    const appid = section?.appid;
    const apiKey = section?.apiKey;
    if (!proxyUrl || !appid || !apiKey) {
        throw new Error("wechat-mpc: proxyUrl, appid and apiKey are required");
    }
    return {
        accountId: accountId ?? null,
        proxyUrl,
        appid,
        apiKey,
    };
}

// 发送文本消息的统一函数，供 outbound sendText 和 sendMedia 调用
function sendOutboundTextViaWs(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    text: string;
}): { ok: boolean; queued?: boolean; error?: string; appid?: string } {
    const to = params.to.trim();
    const text = params.text.trim();
    if (!to || !text) {
        return {ok: false, error: "missing target or text"};
    }

    let account: ResolvedAccount;
    try {
        account = resolveAccountFromConfig(params.cfg, params.accountId ?? null);
    } catch (error) {
        return {ok: false, error: `resolve account failed: ${String(error)}`};
    }

    const accountKey = getAccountKey(account);
    const channel = accountChannels.get(accountKey);
    if (!channel) {
        return {ok: false, error: `channel not running for account=${account.appid}`};
    }

    const result = sendOrQueueOutboundText({
        account,
        accountKey,
        to,
        text,
        source: "gateway",
    });

    return {ok: true, queued: result.queued, appid: account.appid};
}

// 插件主体定义
export const wechatMPCPlugin = createChatChannelPlugin<ResolvedAccount>({
    base: {
        id: channelId,
        meta: channelMeta,
        // 声明渠道能力，供宿主按能力启用/隐藏相关功能
        capabilities: {
            chatTypes: ["direct"],
            reactions: true,
            threads: false,
            media: true,
            nativeCommands: false,
            blockStreaming: false,
        },
        gateway: {
            // 启动单个账号：建立连接、注册回调、更新状态并保持协程存活
            startAccount: async (account) => {
                const accountInfo = account.account;
                const accountKey = getAccountKey(accountInfo);

                // 幂等启动：已有旧连接先销毁再重建
                accountChannels.get(accountKey)?.destroy();
                accountChannels.delete(accountKey);
                cleanupAccountQueues(accountKey);

                // 连接地址附带 appid，供代理侧识别来源公众号
                const wsUrl = new URL(accountInfo.proxyUrl);
                wsUrl.searchParams.set("appid", accountInfo.appid);

                // 启动即设定运行中，由于还没有连上WS，已连接为false
                account.setStatus({...account.getStatus(), running: true, connected: false});

                const channel = new WsChannel({
                    url: wsUrl.toString(),
                    logTag: `${channelId} account=${accountInfo.appid}`,
                    // 连接建立后先鉴权，再更新运行态
                    onConnected: (ch) => {
                        ch.send("auth", accountInfo.apiKey);
                        account.setStatus({...account.getStatus(), running: true, connected: true, lastConnectedAt: Date.now()});
                        flushOutboundQueue(accountKey, accountInfo);
                    },
                    // 断开时标记离线，但保持 running=true（等待自动重连）
                    onDisconnected: () => {
                        account.setStatus({...account.getStatus(), connected: false, lastDisconnect: {at: Date.now()}});
                    },
                    // 记录底层 WebSocket 错误信息，方便排障
                    onError: (event) => {
                        account.setStatus({...account.getStatus(), lastError: String(event)});
                    },
                    // 处理代理推送的上行命令
                    onMessage: (command: string, data: string) => {
                        console.log(`${channelId}, inbound command account=${accountInfo.appid}, command=${command}`);

                        switch (command) {
                            case "msg": {
                                // 协议格式：msg {msgType} {json}
                                // 例：msg text {"appid":"wxd2dcb26557bbcd67","from":"o-Q3fwUo3lNCDfqa4TNrvsVUfeHo","content":"2"}
                                const spaceIndex = data.indexOf(" ");
                                if (spaceIndex < 0) {
                                    console.warn(`${channelId}, invalid msg format (no msgType), account=${accountInfo.appid}`);
                                    break;
                                }
                                const msgType = data.slice(0, spaceIndex);
                                const jsonStr = data.slice(spaceIndex + 1).trim();

                                let msgObj: Record<string, unknown>;
                                try {
                                    msgObj = JSON.parse(jsonStr);
                                } catch (err) {
                                    console.warn(`${channelId}, invalid msg json, account=${accountInfo.appid}`, err);
                                    break;
                                }

                                console.log(`${channelId}, msg account=${accountInfo.appid}, msgType=${msgType}, obj=`, msgObj);

                                // 根据消息类型分发，目前仅处理文本
                                switch (msgType) {
                                    case "text": {
                                        const senderId = String(msgObj.from ?? "");
                                        const contentRaw = String(msgObj.content ?? "");
                                        const content = contentRaw.trim();
                                        const isSlashCommand = content.startsWith("/");
                                        const imageUrls = extractImageUrls(msgObj.imageUrls);

                                        /*console.log(`${channelId}, inbound text parsed`, {
                                            appid: accountInfo.appid,
                                            senderId,
                                            contentLen: content.length,
                                            isSlashCommand,
                                            imageUrlCount: imageUrls.length,
                                            hasRuntime: Boolean(account.channelRuntime),
                                        });*/

                                        if (!senderId || !content) {
                                            console.warn(`${channelId}, invalid text msg (missing from or content), account=${accountInfo.appid}`);
                                            break;
                                        }

                                        if (!account.channelRuntime) {
                                            console.warn(`${channelId}, channelRuntime unavailable, cannot dispatch inbound`);
                                            break;
                                        }

                                        // Keep image URLs in-band so the downstream model can fetch and reason over them.
                                        const rawBody = isSlashCommand
                                            ? content
                                            : (imageUrls.length > 0
                                                ? `${content}\n\n[image_urls]\n${imageUrls.join("\n")}`
                                                : content);

                                        const traceId = `mpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                                        /*console.log(`${channelId}, dispatch start`, {
                                            traceId,
                                            appid: accountInfo.appid,
                                            senderId,
                                            rawBodyLen: rawBody.length,
                                            preview: rawBody.slice(0, 120),
                                        });*/

                                        account.setStatus({...account.getStatus(), lastInboundAt: Date.now()});

                                        // 通过串行队列投递：同一发送者的多条消息按序处理，
                                        // 等待上一条 deliver 完成后再投入下一条，
                                        // 防止 OpenClaw SDK 在同会话并发时跳过前一条的 deliver 回调。
                                        const queueKey = `${accountKey}:${senderId}`;
                                        console.log(`${channelId}, enqueue dispatch`, {traceId, queueKey, pending: senderDispatchQueues.has(queueKey)});
                                        const accepted = enqueueSenderDispatch(queueKey, () => dispatchInboundDirectDmWithRuntime({
                                            cfg: account.cfg,
                                            runtime: {channel: account.channelRuntime as unknown as DispatchDirectDmRuntime["channel"]},
                                            channel: channelId,
                                            channelLabel: channelMeta.label,
                                            accountId: account.accountId,
                                            peer: {kind: "direct", id: senderId},
                                            senderId,
                                            senderAddress: senderId,
                                            recipientAddress: senderId,
                                            conversationLabel: senderId,
                                            rawBody,
                                            commandAuthorized: true,
                                            messageId: traceId,
                                            deliver: async (payload) => {
                                                console.log(`${channelId}, deliver called`, {
                                                    traceId,
                                                    hasText: typeof payload.text === "string",
                                                    textLen: payload.text?.length ?? 0,
                                                    payloadKeys: Object.keys(payload ?? {}),
                                                });

                                                const replyText = payload.text?.trim();

                                                if (!replyText) {
                                                    console.warn(`${channelId}, deliver skipped: empty payload.text`, {
                                                        traceId,
                                                        rawText: payload.text,
                                                    });
                                                    return;
                                                }

                                                if (startsWithEmojiPrefix(replyText)) {
                                                    console.warn(`${channelId}, deliver skipped: starts with emoji`, {
                                                        traceId,
                                                        preview: replyText.slice(0, 120),
                                                    });
                                                    return;
                                                }
                                                // 回复协议：msg text {appid} {toUserOpenId} {text}
                                                const sendResult = sendOrQueueOutboundText({
                                                    account: accountInfo,
                                                    accountKey,
                                                    to: senderId,
                                                    text: replyText,
                                                    source: "deliver",
                                                    traceId,
                                                });
                                                if (!sendResult.sent && sendResult.queued) {
                                                    console.warn(`${channelId}, deliver queued waiting reconnect`, {
                                                        traceId,
                                                        appid: accountInfo.appid,
                                                        senderId,
                                                    });
                                                }
                                            },
                                            onRecordError: (err) => {
                                                console.warn(`${channelId}, record inbound failed account=${accountInfo.appid}`, {
                                                    traceId,
                                                    err,
                                                });
                                            },
                                            onDispatchError: (err, info) => {
                                                console.warn(`${channelId}, dispatch inbound failed account=${accountInfo.appid}, kind=${info.kind}`, {
                                                    traceId,
                                                    err,
                                                    info,
                                                });
                                            },
                                        }));
                                        if (!accepted) {
                                            console.warn(`${channelId}, drop inbound due to sender queue overflow`, {
                                                traceId,
                                                queueKey,
                                                appid: accountInfo.appid,
                                            });
                                        }
                                        break;
                                    }
                                    default:
                                        console.warn(`${channelId}, unknown msgType account=${accountInfo.appid}, msgType=${msgType}`);
                                        break;
                                }
                                break;
                            }
                            default:
                                console.warn(`${channelId}, unknown command account=${accountInfo.appid}, command=${command}`);
                                break;
                        }
                    },
                });

                // 注册并启动连接
                accountChannels.set(accountKey, channel);
                console.log(`${channelId}, startAccount with accountId: ${accountInfo.appid}`);
                channel.connect();

                // 关键：保持 startAccount 任务存活到 abort，避免被宿主误判为退出后触发 auto-restart。
                try {
                    await waitUntilAbort(account.abortSignal);
                } finally {
                    const active = accountChannels.get(accountKey);
                    if (active === channel) {
                        active.destroy();
                        accountChannels.delete(accountKey);
                    }
                    cleanupAccountQueues(accountKey);
                }
            },
            // 停止单个账号：销毁连接并更新状态
            stopAccount: async (account) => {
                const accountInfo = account.account;
                const accountKey = getAccountKey(accountInfo);
                console.log(`${channelId}, stopAccount with accountId: ${accountInfo.appid}`);
                accountChannels.get(accountKey)?.destroy();
                accountChannels.delete(accountKey);
                cleanupAccountQueues(accountKey);
                account.setStatus({...account.getStatus(), running: false, connected: false, lastStopAt: Date.now()});
            }
        },
        // 渠道配置读取与校验逻辑
        config: {
            // 当前实现只暴露一个逻辑账号，配置字段来自 channels.wechat-mpc
            listAccountIds: (_cfg: OpenClawConfig) => ["default"],
            // 启动前配置完整性判断
            isConfigured: (account) => Boolean(account.proxyUrl && account.appid && account.apiKey),
            // 统一启用，是否真正可运行由 isConfigured 决定
            isEnabled: () => true,
            // 从全局配置中解析渠道账号配置
            resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveAccountFromConfig(cfg, accountId),
        },
        status: {
            buildAccountSnapshot: ({account, runtime}) => ({
                accountId: "default",
                configured: Boolean(account.proxyUrl && account.appid && account.apiKey),
                enabled: true,
                ...runtime
            })
        }
    },
    outbound: {
        base: {
            deliveryMode: "gateway",
        },
        attachedResults: {
            channel: channelId,
            sendText: async (ctx) => {
                console.log(`${channelId}, outbound sendText called`, {
                    accountId: ctx.accountId ?? "default",
                    to: ctx.to,
                    textLen: (ctx.text ?? "").length,
                    textPreview: (ctx.text ?? "").slice(0, 120),
                }, ctx);

                const result = sendOutboundTextViaWs({
                    cfg: ctx.cfg,
                    accountId: ctx.accountId ?? null,
                    to: ctx.to,
                    text: ctx.text,
                });
                console.log(`${channelId}, outbound sendText result`, result);

                if (!result.ok) {
                    throw new Error(`wechat-mpc outbound text failed: ${result.error ?? "unknown error"}`);
                }

                if (result.queued) {
                    console.warn(`${channelId}, outbound sendText queued waiting reconnect`, {
                        accountId: ctx.accountId ?? "default",
                        to: ctx.to,
                    });
                }

                return {
                    messageId: `mpc-out-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                    timestamp: Date.now(),
                    conversationId: ctx.to,
                    meta: {
                        mode: "text",
                        appid: result.appid,
                    },
                };
            },
            sendMedia: async (ctx) => {
                // 当前代理协议仅支持 text 回写，媒体先退化为链接文本。
                const mediaUrl = (ctx.mediaUrl ?? "").trim();
                const caption = (ctx.text ?? "").trim();
                const text = caption
                    ? `${caption}\n\n[media_url]\n${mediaUrl}`
                    : `[media_url]\n${mediaUrl}`;

                const result = sendOutboundTextViaWs({
                    cfg: ctx.cfg,
                    accountId: ctx.accountId ?? null,
                    to: ctx.to,
                    text,
                });

                if (!result.ok) {
                    throw new Error(`wechat-mpc outbound media failed: ${result.error ?? "unknown error"}`);
                }

                if (result.queued) {
                    console.warn(`${channelId}, outbound sendMedia queued waiting reconnect`, {
                        accountId: ctx.accountId ?? "default",
                        to: ctx.to,
                    });
                }

                return {
                    messageId: `mpc-out-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                    timestamp: Date.now(),
                    conversationId: ctx.to,
                    meta: {
                        mode: "media-fallback-text",
                        appid: result.appid,
                        mediaUrl,
                    },
                };
            },
        },
    },
});
