# 常驻跑 dsh（xbot profile）：退出了 15 秒后自动拉起，输出写到 ~\.dsh\xbot.log。
# 一般不用手动跑，由 autostart.ps1 注册的计划任务在登录时启动。
#
# 令牌：优先用当前环境里的 XBOT_TOKEN / XBOT_API_BASE_URL，没有就读 ~\.openclaw\openclaw.json。

$ErrorActionPreference = "Continue"
# dsh 输出是 UTF-8，不设的话 5.1 按系统代码页解码，日志里中文会乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# 计划任务带的是登录时的 PATH；刷新一次，新装的 adb 等才找得到
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
# 手机在云端时才需要：设成 ~\.ssh\config 里的别名（例如 xbot-phone），截图会先从那台机器取回再传图床。
# 用本地手机就不用设。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$work = Join-Path $dshHome "xbot-workspace"   # dsh 的工作区 = 启动目录，不能是插件目录
$log = Join-Path $dshHome "xbot.log"

if (-not ($env:XBOT_TOKEN -and $env:XBOT_API_BASE_URL)) {
    $cfgPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
    if (-not (Test-Path $cfgPath)) { throw "没有 XBOT_TOKEN，也找不到 $cfgPath" }
    # 用 node 解析：Windows PowerShell 5.1 的 ConvertFrom-Json 读不了这份文件（计划任务跑的就是 5.1）
    $pair = @(& node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).channels.xbot;console.log(c.xchatbotApiBaseUrl);console.log(c.xchatbotToken)" $cfgPath)
    if ($pair.Count -lt 2 -or -not $pair[0] -or -not $pair[1]) { throw "openclaw.json 里没读到 xbot 的地址或令牌" }
    $env:XBOT_API_BASE_URL = $pair[0]
    $env:XBOT_TOKEN = $pair[1]
}

New-Item -ItemType Directory -Force $work | Out-Null
Set-Location $work

function Write-Log([string]$line) {
    "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $line | Out-File -FilePath $log -Append -Encoding utf8
}

while ($true) {
    # 日志超过 5MB 就留一份旧的重新记，免得越攒越大
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }

    Write-Log "启动 dsh"
    # 网页后台跟着一起起：只绑本机 3939，登录链接（带 token）会写进日志
    & dsh --profile xbot --no-open --port 3939 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
    Write-Log "dsh 退出（$LASTEXITCODE），15 秒后重启"
    Start-Sleep -Seconds 15
}
