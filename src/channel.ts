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
import {createAccountStatusSink, waitUntilAbort} from "openclaw/plugin-sdk/channel-lifecycle";
import {WsChannel} from "./ws-channel.js";

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

// 生成账号唯一键：accountId + appid，避免多账号场景下串连
function getAccountKey(account: ResolvedAccount): string {
    return `${account.accountId ?? "default"}:${account.appid}`;
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
            media: false,
            nativeCommands: false,
            blockStreaming: false,
        },
        gateway: {
            // 启动单个账号：建立连接、注册回调、更新状态并保持协程存活
            startAccount: async (account) => {
                const accountInfo = account.account;
                const accountKey = getAccountKey(accountInfo);
                const updateStatus = createAccountStatusSink({
                    accountId: account.accountId,
                    setStatus: account.setStatus,
                });

                // 幂等启动：已有旧连接先销毁再重建
                accountChannels.get(accountKey)?.destroy();
                accountChannels.delete(accountKey);

                // 连接地址附带 appid，供代理侧识别来源公众号
                const wsUrl = new URL(accountInfo.proxyUrl);
                wsUrl.searchParams.set("appid", accountInfo.appid);

                const channel = new WsChannel({
                    url: wsUrl.toString(),
                    logTag: `${channelId} account=${accountInfo.appid}`,
                    // 连接建立后先鉴权，再更新运行态
                    onConnected: (ch) => {
                        ch.send("auth", accountInfo.apiKey);
                        updateStatus({
                            configured: true,
                            running: true,
                            connected: true,
                            lastConnectedAt: Date.now(),
                            lastError: null,
                        });
                    },
                    // 断开时标记离线，但保持 running=true（等待自动重连）
                    onDisconnected: () => {
                        updateStatus({
                            running: true,
                            connected: false,
                            lastDisconnect: "websocket disconnected",
                        });
                    },
                    // 记录底层 WebSocket 错误信息，方便排障
                    onError: (event) => {
                        updateStatus({
                            lastError: String((event as { message?: string })?.message ?? "websocket error"),
                        });
                    },
                    // 处理代理推送的上行命令
                    onMessage: (command: string, data: string, ws: WsChannel) => {
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
                                        const content = String(msgObj.content ?? "");

                                        if (!senderId || !content) {
                                            console.warn(`${channelId}, invalid text msg (missing from or content), account=${accountInfo.appid}`);
                                            break;
                                        }

                                        if (!account.channelRuntime) {
                                            console.warn(`${channelId}, channelRuntime unavailable, cannot dispatch inbound`);
                                            break;
                                        }

                                        updateStatus({lastInboundAt: Date.now()});

                                        // 投递到 OpenClaw 的标准 DM 入站管线（路由 / 会话 / 回复调度）。
                                        void dispatchInboundDirectDmWithRuntime({
                                            cfg: account.cfg,
                                            runtime: {channel: account.channelRuntime},
                                            channel: channelId,
                                            channelLabel: channelMeta.label,
                                            accountId: account.accountId,
                                            peer: {kind: "direct", id: senderId},
                                            senderId,
                                            senderAddress: senderId,
                                            recipientAddress: accountInfo.appid,
                                            conversationLabel: senderId,
                                            rawBody: content,
                                            messageId: `mpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                                            deliver: async (payload) => {
                                                const replyText = payload.text?.trim();
                                                if (!replyText) {
                                                    return;
                                                }
                                                                // 回复协议：msg text {appid} {toUserOpenId} {text}
                                                ws.send("msg", `text ${accountInfo.appid} ${senderId} ${replyText}`);
                                                                // 打印模型回复，便于联调
                                                console.log(`${channelId}, reply to ${senderId}: ${replyText}`);
                                            },
                                            onRecordError: (err) => {
                                                console.warn(`${channelId}, record inbound failed account=${accountInfo.appid}`, err);
                                            },
                                            onDispatchError: (err, info) => {
                                                console.warn(`${channelId}, dispatch inbound failed account=${accountInfo.appid}, kind=${info.kind}`, err);
                                            },
                                        });
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
                updateStatus({
                    configured: true,
                    enabled: true,
                    running: true,
                    connected: false,
                    mode: "websocket",
                    lastStartAt: Date.now(),
                });
                channel.connect();

                // 关键：保持 startAccount 任务存活到 abort，避免被宿主误判为退出后触发 auto-restart。
                try {
                    await waitUntilAbort(account.abortSignal);
                } finally {
                    const active = accountChannels.get(accountKey);
                    if (active === channel) {
                        active.destroy();
                        accountChannels.delete(accountKey);
                        updateStatus({
                            running: false,
                            connected: false,
                            lastStopAt: Date.now(),
                        });
                    }
                }
            },
            // 停止单个账号：销毁连接并更新状态
            stopAccount: async (account) => {
                const accountInfo = account.account;
                const accountKey = getAccountKey(accountInfo);
                const updateStatus = createAccountStatusSink({
                    accountId: account.accountId,
                    setStatus: account.setStatus,
                });
                console.log(`${channelId}, stopAccount with accountId: ${accountInfo.appid}`);
                accountChannels.get(accountKey)?.destroy();
                accountChannels.delete(accountKey);
                updateStatus({
                    running: false,
                    connected: false,
                    lastStopAt: Date.now(),
                });
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
            resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
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
        }
    },
});
