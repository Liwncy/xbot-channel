# 登录 Windows 时自动在后台启动 dsh（run.ps1）。不需要管理员权限。
#
#   .\autostart.ps1            注册并立刻启动
#   .\autostart.ps1 -Remove    取消并停掉
#
# 注意：是「登录时」启动，不是「开机时」。没开自动登录的话，开机后要先登录一次。

param([switch]$Remove)

$taskName = "xbot-dsh"
$run = Join-Path $PSScriptRoot "run.ps1"

if ($Remove) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已取消自启。若 dsh 还在跑，另外结束它。"
    return
}

$user = "$env:USERDOMAIN\$env:USERNAME"
# Windows 11 默认用 Windows Terminal 承载控制台，光靠 -WindowStyle Hidden 挡不住它弹出一个空白窗口；
# 用 conhost --headless 起，才是真的没有窗口。输出本来就写进 xbot.log。
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$run`""
# 登录时起一次；另外每 5 分钟点一下，进程要是被系统收掉了（更新重启、注销之类）会自己补起来。
# 已经在跑时 MultipleInstances=IgnoreNew 会直接忽略，不会起第二个。
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$tick = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$trigger = @($logon, $tick)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "xchatbot 的 DeepSeek Harness（xbot profile），登录时后台常驻" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "已注册并启动：$taskName（日志 ~\.dsh\xbot.log）"
