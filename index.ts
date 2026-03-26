// index.ts
import {defineChannelPluginEntry} from "openclaw/plugin-sdk/core";
import {wechatMPCPlugin} from "./src/channel.js";
// 入口点文档
// https://docs.openclaw.ai/plugins/sdk-entrypoints
export default defineChannelPluginEntry({
    id: "wechat-mpc",
    name: "WeChatMP-ThirdParty",
    description: "Third-party platform-based OpenClaw WeChat Official Account (微信公众号) channel plugin",
    plugin: wechatMPCPlugin,
    registerFull(api) {

    },
});
