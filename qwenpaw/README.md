# qwenpaw-xbot-channel

本目录是 [xbot-channel](https://github.com/Liwncy/xbot-channel) 里的 QwenPaw 通道。打包和安装都在这个目录里做。

QwenPaw 只连 [xchatbot](https://github.com/lwc--/xchatbot)。不要开 QwenPaw 自带微信。

```text
适配器 → xchatbot（过滤、点名、转 URL）
       → POST /api/channels/xbot/inbound
       → QwenPaw Agent
       → POST xchatbot /openclaw/outbound
       → 原适配器发出去
```

## 安装

在 [AgentScope Platform](https://platform.agentscope.io/deploy) 控制台 Plugin Manager 上传 Zip（`plugin.json` 必须在压缩包根目录）。

```bash
# 在本目录打包，不要把外层文件夹打进去
Compress-Archive -Path plugin.json,plugin.py,channel.py,config.py,inbound.py,outbound.py,routes.py,__init__.py,requirements.txt,README.md -DestinationPath xbot-channel.zip
```

装好后：频道里打开 **Xbot**，填：

| 字段 | 说明 |
|---|---|
| xchatbot 地址 | Worker 公网，例如 `https://xbot.lwcfworker.dpdns.org` |
| xchatbot Token | 与 Worker `AGENT_BRIDGE_TOKEN` 相同 |
| 入站 Token | 可空，空则同 xchatbot Token |

不要启用 WeChat / iLink。

## 入站

xchatbot `POST {QwenPaw}/api/channels/xbot/inbound`，Bearer 为入站 Token。

若平台还校验 `x-qwenpaw-runtime-token`，Worker 会带同一个值。

## 出站

频道 `POST {xchatbotApiBaseUrl}/openclaw/outbound`，带浏览器 User-Agent，避免 Cloudflare 1010 拦住 Python urllib。

出站失败只写日志，不把控制台这一轮打挂。若仍是 1010，在 Cloudflare 给该路径加 WAF skip，或放行 QwenPaw 出口 IP。
