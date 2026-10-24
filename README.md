# xbot-channel

各 Agent 连 [xchatbot](https://github.com/lwc--/xchatbot) 的通道。适配器留在 xchatbot，这里只负责收消息、跑 Agent、把回复送回去。

```text
适配器 → xchatbot（过滤、点名、转 URL）
       → POST {Agent}/api/channels/xbot/inbound
       → Agent
       → POST {xchatbot}/openclaw/outbound
       → 原适配器发出去
```

| 目录 | 谁 | 怎么装 |
|---|---|---|
| [openclaw/](openclaw/) | OpenClaw | 扩展路径指这个目录 |
| [qwenpaw/](qwenpaw/) | QwenPaw | 只打包这个目录，`plugin.json` 在 zip 根上 |

## 入站

xchatbot `POST {Agent}/api/channels/xbot/inbound`，`Authorization: Bearer <token>`。

| 字段 | 必填 | 说明 |
|---|---|---|
| `messageId` | 是 | 消息 id |
| `platform` | 是 | 如 `golem`、`web` |
| `from` | 是 | 发送者 id |
| `source` | 是 | `private` 或 `group` |
| `roomId` | 群消息 | 群 id |
| `senderName` |  | 显示名 |
| `conversationId` |  | 会话 id，群里通常等于 `roomId` |
| `accountId` |  | 默认 `Primary` |
| `type` |  | `text`、`image`、`video`、`emoji`、`voice` |
| `content` |  | 正文 |
| `mediaUrl` |  | 媒体公网 URL |
| `mediaKind` |  | `image`、`video`、`emoji`、`voice` |
| `videoUrl` |  | 视频另有地址时 |
| `timestamp` |  | 毫秒；秒级会乘 1000 |

## 出站

通道 `POST {xchatbot}/openclaw/outbound`，Bearer 与 xchatbot `AGENT_BRIDGE_TOKEN` 相同。

| 字段 | 必填 | 说明 |
|---|---|---|
| `platform` | 是 | 原入站的 `platform` |
| `from` | 是 | 原发送者，私聊收件人 |
| `source` |  | `private` 或 `group`；有 `roomId` 时按群发 |
| `roomId` | 群消息 | 群 id |
| `messageId` |  | 对应哪条入站 |
| `replies` | 是 | 至少一条 |

`replies` 每一项：

| `type` | 字段 |
|---|---|
| `text` | `content` |
| `image` | `url` |
| `voice` | `url`，可选 `duration`、`format` |
| `video` | `url`，可选 `thumbUrl`、`duration` |
| `link` | `url`，可选 `title`、`desc`、`thumbUrl` |
