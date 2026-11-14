# openclaw-xbot-channel

本目录是 [xbot-channel](https://github.com/Liwncy/xbot-channel) 里的 OpenClaw 通道。下面的命令在这个目录里跑。

OpenClaw 只连 [xchatbot](https://github.com/lwc--/xchatbot)，不认微信 / Golem / 其它适配器。

哪个适配器进的消息，由 xchatbot 带 `platform`；回复也只 POST 回 xchatbot，再由对应适配器发出去。

```text
适配器 → xchatbot（过滤、点名、转 URL）
       → POST /api/channels/xbot/inbound
       → OpenClaw Agent
       → POST xchatbot /openclaw/outbound
       → 原适配器发出去
```

## 职责

| 谁 | 做什么 |
|---|---|
| **xchatbot** | 所有适配器进出、过滤、媒体 URL、`/openclaw/outbound` |
| **本频道** | 收 inbound、跑 Agent、把回复 POS 回 xchatbot |

## 配置

```json
{
  "channels": {
    "xbot": {
      "enabled": true,
      "xchatbotApiBaseUrl": "https://xbot.example.com",
      "xchatbotToken": "<same as AGENT_BRIDGE_TOKEN>",
      "botName": "小聪明儿",
      "accounts": {
        "Primary": { "enabled": true, "name": "小聪明儿" }
      }
    }
  }
}
```

`wechatApiBaseUrl` 已废弃，可以删。

可选：

| 配置 | 默认 | 说明 |
|---|---|---|
| `wsEnabled` | `true` | 是否主动连 xchatbot 的 WebSocket 邮箱。设 `false` 只走 HTTP |
| `wsBrain` | `openclaw` | 对应 xchatbot `agent_brain.brain_key` |
| `mediaRoots` | `~/.openclaw/workspace` | 回复里的本地图片（`image:` 行或本地路径）发之前会传到图床换成链接，只认这些目录里的图片（jpg/png/gif/webp，10MB 内），其余一律不传 |
| `phoneHost` | 空 | 手机在云端那台机器上时填 `~/.ssh/config` 里的别名：回复里 `image:/tmp/<文件名>.jpg`（只认 `/tmp` 下单个图片文件）会先用 ssh 取回再传图床；留空不取 |

## 入站

两条路，同一份 payload，必须带 `platform`（如 `golem`、`web`）：

1. **WebSocket 邮箱（推荐）**：通道在 gateway 启动后主动连 `wss://{xchatbotApiBaseUrl}/agent/ws?brain=<wsBrain>`，`Authorization: Bearer <xchatbotToken>`。xchatbot 把入站推过来，通道**先去重、先回 `ack`，再跑 agent**。`ack` 只表示收下了，不表示答完。断线自动重连（1s 起步指数退避，封顶 30s）；被另一个实例顶掉（close 4000）会等 60s 再连。
   - 需要 xchatbot 把这个大脑切到 ws：`UPDATE agent_brain SET transport = 'ws' WHERE brain_key = 'openclaw';`
   - 不切的话连上也收不到消息，行为和以前一样走 HTTP。
   - 需要 Node 带全局 `WebSocket` 且支持 `{headers}`（Node 24 已验证；没有时自动退回 HTTP 并打一条 warn）。
2. **HTTP 直推（兜底）**：xchatbot POST `/api/channels/xbot/inbound`。邮箱里没人连着时 xchatbot 自动走这条。

CLI 进程不会连邮箱，只有 gateway 的服务生命周期才连，避免把 gateway 的连接顶掉。

## 出站

频道 POST `{xchatbotApiBaseUrl}/openclaw/outbound`，Bearer 为 `xchatbotToken`。

## 开发

```bash
npm install
npm run typecheck
npm run selfcheck
npm run build
```
