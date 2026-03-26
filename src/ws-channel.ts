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

/** WebSocket OPEN 状态常量（readyState === 1） */
const WS_OPEN = 1;
/** 指数退避重连的初始延迟（毫秒） */
const RECONNECT_BASE_DELAY_MS = 1000;
/** 指数退避重连的最大延迟上限（毫秒） */
const RECONNECT_MAX_DELAY_MS = 30_000;

type WsEventListener = (event: any) => void;

type WsConnection = {
    /** 连接状态，语义与原生 WebSocket.readyState 一致 */
    readyState: number;
    /** 发送文本帧 */
    send: (data: string) => void;
    /** 主动关闭连接 */
    close: (code?: number, reason?: string) => void;
    /** 注册事件监听 */
    addEventListener: (type: string, listener: WsEventListener) => void;
    /** 移除事件监听 */
    removeEventListener: (type: string, listener: WsEventListener) => void;
};

export type WsChannelOptions = {
    /** WebSocket 连接 URL */
    url: string;
    /** 用于日志的标识前缀 */
    logTag?: string;
    /** 连接建立后回调 */
    onConnected?: (channel: WsChannel) => void;
    /** 收到字符串消息时回调，消息格式为 '{command} {data}' */
    onMessage?: (command: string, data: string, channel: WsChannel) => void;
    /** 连接断开后回调（重连前触发） */
    onDisconnected?: () => void;
    /** WebSocket 错误回调 */
    onError?: (event: any) => void;
};

/**
 * 封装单条 WebSocket 长连接的全生命周期：
 * - 自动指数退避重连
 * - generation 机制屏蔽旧连接的过期回调
 * - 统一的文本帧发送格式 `'{command} {data}'`
 *
 * 用法：
 *   const ch = new WsChannel({ url, onConnected, onMessage });
 *   ch.connect();
 *   // ... 后续通过 onConnected 回调里的 channel 参数或持有引用调用 send
 *   ch.destroy(); // 主动销毁，不再重连
 */
export class WsChannel {
    private readonly options: WsChannelOptions;

    /** 当前有效的 WebSocket 实例 */
    private ws: WsConnection | null = null;
    /** 是否允许自动重连；destroy 后会永久关闭 */
    private shouldReconnect = false;
    /** 重连定时器句柄 */
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** 连续重连失败次数，用于计算指数退避 */
    private reconnectAttempts = 0;
    /** 连接代际编号，用于忽略旧连接的过期回调 */
    private generation = 0;
    /** 当前连接绑定的事件监听引用，便于统一解绑 */
    private listeners: {
        open?: WsEventListener;
        message?: WsEventListener;
        close?: WsEventListener;
        error?: WsEventListener;
    } = {};

    constructor(options: WsChannelOptions) {
        this.options = options;
    }

    /** 建立连接，允许自动重连 */
    connect(): void {
        this.shouldReconnect = true;
        this.connectInternal();
    }

    /**
     * 发送文本帧，格式为 `'{command} {data}'`
     * data 为空时仅发送指令头
     * @returns 是否发送成功
     */
    send(command: string, data: string = ""): boolean {
        if (!this.ws || this.ws.readyState !== WS_OPEN) {
            console.warn(`${this.tag}, send failed: not connected`);
            return false;
        }
        try {
            const frame = data ? `${command} ${data}` : command;
            console.log(`${this.tag}, send command=${command}, data=${data}`);
            this.ws.send(frame);
            return true;
        } catch (error) {
            console.warn(`${this.tag}, send failed`, error);
            return false;
        }
    }

    /** 主动销毁：关闭连接并永久停止重连 */
    destroy(): void {
        this.shouldReconnect = false;
        this.clearReconnectTimer();
        this.detachListeners();
        if (this.ws) {
            try {
                this.ws.close(1000, "destroy");
            } catch (error) {
                console.warn(`${this.tag}, close failed`, error);
            }
            this.ws = null;
        }
    }

    // ── 内部实现 ──────────────────────────────────────────────

    /** 日志前缀，未设置时使用默认值 */
    private get tag(): string {
        return this.options.logTag ?? "ws-channel";
    }

    /**
     * 解析入站文本帧，协议格式为 `'{command} {data}'`。
     * 当帧中不存在空格时，视为仅包含 command，data 为空字符串。
     */
    private parseInboundFrame(frame: string): { command: string; data: string } | null {
        const trimmed = frame.trim();
        if (!trimmed) {
            return null;
        }
        const firstSpaceIndex = trimmed.indexOf(" ");
        if (firstSpaceIndex < 0) {
            return {command: trimmed, data: ""};
        }
        return {
            command: trimmed.slice(0, firstSpaceIndex),
            data: trimmed.slice(firstSpaceIndex + 1),
        };
    }

    /** 清理待执行的重连定时器，避免重复连接 */
    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /** 解绑当前连接上的事件监听，防止重复注册和内存泄漏 */
    private detachListeners(): void {
        if (!this.ws) {
            return;
        }
        if (this.listeners.open) this.ws.removeEventListener("open", this.listeners.open);
        if (this.listeners.message) this.ws.removeEventListener("message", this.listeners.message);
        if (this.listeners.close) this.ws.removeEventListener("close", this.listeners.close);
        if (this.listeners.error) this.ws.removeEventListener("error", this.listeners.error);
        this.listeners = {};
    }

    /** 按指数退避策略安排下一次重连 */
    private scheduleReconnect(): void {
        if (!this.shouldReconnect) {
            return;
        }
        this.clearReconnectTimer();
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
            RECONNECT_MAX_DELAY_MS,
        );
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => this.connectInternal(), delay);
        console.log(`${this.tag}, schedule reconnect delay=${delay}ms`);
    }

    /**
     * 发起一次真实连接流程：
     * - 校验运行时 WebSocket 支持
     * - 递增 generation，使旧连接回调失效
     * - 绑定 open/message/error/close 事件
     */
    private connectInternal(): void {
        if (!this.shouldReconnect) {
            return;
        }

        const WebSocketCtor = (globalThis as any).WebSocket;
        if (!WebSocketCtor) {
            throw new Error(`${this.tag}: current runtime does not provide built-in WebSocket`);
        }

        this.clearReconnectTimer();
        this.detachListeners();

        // generation 自增后，旧连接触发的所有事件回调都会被静默忽略。
        this.generation += 1;
        const currentGeneration = this.generation;

        const ws = new WebSocketCtor(this.options.url) as WsConnection;
        this.ws = ws;

        const onOpen: WsEventListener = () => {
            if (this.generation !== currentGeneration || !this.shouldReconnect) {
                return;
            }
            this.reconnectAttempts = 0;
            console.log(`${this.tag}, connected`);
            this.options.onConnected?.(this);
        };

        const onMessage: WsEventListener = (event) => {
            if (this.generation !== currentGeneration || !this.shouldReconnect) {
                return;
            }
            const data = event?.data;
            if (typeof data !== "string") {
                console.warn(`${this.tag}, ignore non-string message`);
                return;
            }
            const parsed = this.parseInboundFrame(data);
            if (!parsed) {
                console.warn(`${this.tag}, ignore empty message`);
                return;
            }

            // 协议内部控制指令：仅用于连接握手，不透传给业务层回调。
            switch (parsed.command) {
                case "welcome":
                    return;
                case "accepted":
                    console.log(`${this.tag}, server accepted`);
                    return;
                default:
                    break;
            }

            this.options.onMessage?.(parsed.command, parsed.data, this);
        };

        const onError: WsEventListener = (event) => {
            if (this.generation !== currentGeneration) {
                return;
            }
            console.warn(`${this.tag}, error`, event);
            this.options.onError?.(event);
        };

        const onClose: WsEventListener = () => {
            if (this.generation !== currentGeneration) {
                return;
            }
            this.ws = null;
            console.log(`${this.tag}, closed`);
            this.options.onDisconnected?.();
            this.scheduleReconnect();
        };

        this.listeners = { open: onOpen, message: onMessage, error: onError, close: onClose };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
    }
}

