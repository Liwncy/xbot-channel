# 让 mobilecli 的后台服务常驻，并且带着 ANDROID_HOME 起来。
#
#   .\mobilecli-daemon.ps1 -Install   注册登录自启并立刻启动
#   .\mobilecli-daemon.ps1 -Remove    取消并停掉
#   .\mobilecli-daemon.ps1            前台跑（计划任务就是跑这个）
#
# 为什么要常驻：手机工具（mobile-mcp）靠 mobilecli 的后台服务连手机，服务默认闲置 30 分钟就退出，
# 下次由工具自动拉起；这个自动拉起在这台机器上常常 5 秒内等不到就报「daemon did not start listening」，
# 小聪明儿就会说手机不在手边。常驻起来就不用再拉起。
# 服务继承谁启动它的环境，所以这里统一带上 ANDROID_HOME（mobilecli 只认它下面的 platform-tools\adb）。

param([switch]$Install, [switch]$Remove)

$taskName = "xbot-mobilecli"

if ($Remove) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process mobilecli* -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "已取消自启并停掉服务。"
    return
}

if ($Install) {
    $self = Join-Path $PSScriptRoot "mobilecli-daemon.ps1"
    $user = "$env:USERDOMAIN\$env:USERNAME"
    # conhost --headless：不弹窗口（同 autostart.ps1）
    $action = New-ScheduledTaskAction -Execute "conhost.exe" `
        -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$self`""
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    $tick = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $tick) -Settings $settings `
        -Description "mobilecli 后台服务常驻（小聪明儿的手机工具用）" -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "已注册并启动：$taskName"
    return
}

# ---- 前台跑 ----
$ErrorActionPreference = "Continue"

$bin = Get-ChildItem (Join-Path $env:LOCALAPPDATA "npm-cache\_npx\*\node_modules\@mobilenext\mobilecli-windows-amd64\mobilecli-windows-amd64.exe") -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $bin) { throw "没找到 mobilecli（先让 mobile-mcp 用 npx 跑一次，把它下到缓存里）" }

$platformTools = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Google.PlatformTools_*") -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "platform-tools\adb.exe") } | Select-Object -First 1
if (-not $platformTools) { throw "没找到 platform-tools（winget install Google.PlatformTools）" }
$env:ANDROID_HOME = $platformTools.FullName
$env:MOBILEMCP_DISABLE_TELEMETRY = "1"

while ($true) {
    # 已经有服务在跑就不再起第二个（计划任务每 5 分钟会点一下）
    $status = & $bin.FullName daemon status 2>$null | Out-String
    if ($status -notmatch '"running":\s*true') {
        # idle-timeout 0 = 永不因闲置退出
        & $bin.FullName daemon start --idle-timeout 0 2>&1 | Out-Null
    } else {
        Start-Sleep -Seconds 60
        continue
    }
    Start-Sleep -Seconds 15
}
