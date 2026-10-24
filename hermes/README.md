# hermes

本目录是 [xbot-channel](https://github.com/Liwncy/xbot-channel) 里的 Hermes 通道。Hermes 只连 [xchatbot](https://github.com/lwc--/xchatbot)。不要开 Hermes 自带微信。

```text
适配器 → xchatbot
       → POST {本机}/api/channels/xbot/inbound
       → Hermes
       → POST {xchatbot}/openclaw/outbound
       → 原适配器发出去
```

## 安装

插件目录接到 Hermes 家目录（本机是 `%USERPROFILE%\.hermes`，由 `HERMES_HOME` 决定）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\xbot" -Target "D:\Workspace\mygithub\xbot-channel\hermes"
hermes plugins enable xbot
```

`config.yaml` 的 `gateway.platforms` 加上：

```yaml
xbot:
  enabled: true
  extra:
    xchatbot_api_base_url: https://xbot.example.com
    token: "<same as AGENT_BRIDGE_TOKEN>"
    host: 127.0.0.1
    port: 8642
```

然后 `hermes gateway run`。默认只听本机 `8642`。Worker 到不了 `127.0.0.1`，前面要有一条隧道，把公网地址填进 xchatbot 的 `HERMES_BASE_URL`。

入站 Bearer 默认跟 `token` 相同。xchatbot 已拦过谁能说话，这里只验这把钥匙。

## 自检

```powershell
python selfcheck.py
hermes plugins doctor .
```
