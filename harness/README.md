# dsh-xbot-channel

DeepSeek Harness（`dsh`）连 [xchatbot](https://github.com/lwc--/xchatbot) 的频道。

```text
xchatbot ──WebSocket 邮箱──▶ 本插件 ──▶ Harness agent
xchatbot ◀──POST /openclaw/outbound── 本插件
```

只连出去，不开端口，不需要隧道。入站协议和 openclaw 通道一样。

## 装

```powershell
dsh plugin --profile xbot add D:\Workspace\mygithub\xbot-channel\harness
$env:XBOT_API_BASE_URL = "https://xbot.example.com"
$env:XBOT_TOKEN        = "<与 Worker AGENT_BRIDGE_TOKEN 相同>"
dsh --profile xbot
```

Node 要 24.9 以上（全局 `WebSocket` 需要能带 `Authorization` 头）。

**在一个专用空目录里启动。** agent 的工作区就是 `dsh` 启动时所在的目录，它能读写这个目录。别在插件目录或项目目录里跑：

```powershell
mkdir $env:USERPROFILE\.dsh\xbot-workspace
cd $env:USERPROFILE\.dsh\xbot-workspace
dsh --profile xbot
```

## xchatbot 侧

```sql
UPDATE agent_brain SET transport = 'ws' WHERE brain_key = 'harness';
```

然后在群里发 `#脑子 harness`。

## 配置

写在 profile 的 `cordis.patch.yml` 里，替换 `xbot-channel` 这一行的 `config`（要把两个地址 / token 一起写回去）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `xchatbotApiBaseUrl` | 必填 | Worker 公网根 |
| `xchatbotToken` | 必填 | 与 `AGENT_BRIDGE_TOKEN` 相同 |
| `brain` | `harness` | 对应 `agent_brain.brain_key` |
| `approvalPolicy` | `never` | 需要人工审批的工具调用直接拒掉。微信里没人能点同意 |
| `permissionMode` | 不设 | 沙箱预设名，不设走 profile 默认 |
| `idleTimeoutMs` | 30 分钟 | 聊天闲置多久收掉 agent |
| `turnTimeoutMs` | 5 分钟 | 一轮最长跑多久 |
| `outboundTimeoutMs` | 30 秒 | 单次出站 POST 超时；失败会按 3s / 10s / 30s 再试，最多 4 次 |

## 行为

- 每个聊天一个 agent，有记忆；同一聊天里的消息排队。
- 进程重启后记忆清空（会话只在内存里）。
- 群里没点名（`addressed: false`）时回 `NO_REPLY` 或空，就不发。
- 跑失败：私聊 / 被点名回「没弄成，再试下」，没点名的群消息不吭声。
- 只回文字。图片 / 视频 URL 会写进给模型的正文，模型回的图片不会发出去。

## 自检

```powershell
node selfcheck.mjs
```

只测不依赖 dsh 的纯函数。真正接 agent 要在 dsh 里跑。

## 安全

这个 agent 能用 Harness 的工具（读写文件、执行命令）。群里任何人点名都会触发。

上线前先确认 profile 的沙箱预设，别开全权限。
