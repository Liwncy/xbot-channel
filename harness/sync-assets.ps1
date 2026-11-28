# 把小聪明儿的人设和技能同步出去。改过 IDENTITY / USER / SOUL / AGENTS 或技能后重跑一遍即可。
#
#   .\sync-assets.ps1
#
# DSH 只读 profile 里的一个 SOUL.md（system-prompt.personaPrefix），所以把四份拼进去。
# Hermes 同样只把 ~/.hermes/SOUL.md 读进人设，四份也拼进那一个文件。不碰 memories/。
# OpenClaw 按文件名自己读，四份原样拷进 workspace。拷 IDENTITY 时保留已有的 Avatar 行。
# 技能 -> DSH 与 Hermes 的 skills\<名字>\（这两家要求 name 是 kebab-case，共用技能的中文名在副本里改成目录名）
# OpenClaw 的技能保持源文件里的中文 name。
#
# 源文件在 xchatbot\.docs\agent\shared，这里只复制，不改源。

param(
    [string]$Shared = "D:\Workspace\mygithub\xchatbot\.docs\agent\shared",
    [string]$ProfileName = "xbot",
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
    [string]$OpenClawWorkspace = $(Join-Path $env:USERPROFILE ".openclaw\workspace"),
    [string]$HermesHome = $(if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" })
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)

$profileDir = Join-Path $DshHome "profiles\$ProfileName"
if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir（先 dsh plugin --profile $ProfileName add …）" }

$personaFiles = @('IDENTITY.md', 'USER.md', 'SOUL.md', 'AGENTS.md')
$persona = ($personaFiles | ForEach-Object {
    [System.IO.File]::ReadAllText((Join-Path $Shared $_), $utf8).TrimEnd()
}) -join "`n`n"
[System.IO.File]::WriteAllText((Join-Path $profileDir "SOUL.md"), $persona + "`n", $utf8)
Write-Host "人设 -> $profileDir\SOUL.md（四份拼在一起）"

if (Test-Path $HermesHome) {
    [System.IO.File]::WriteAllText((Join-Path $HermesHome "SOUL.md"), $persona + "`n", $utf8)
    Write-Host "人设 -> $HermesHome\SOUL.md（四份拼在一起）"
}

if (Test-Path $OpenClawWorkspace) {
    foreach ($name in $personaFiles) {
        $from = Join-Path $Shared $name
        $to = Join-Path $OpenClawWorkspace $name
        if ($name -eq 'IDENTITY.md' -and (Test-Path $to)) {
            $avatar = Select-String -Path $to -Pattern 'Avatar:\s*\S+' | Select-Object -First 1
            Copy-Item $from $to -Force
            if ($avatar) {
                $body = [System.IO.File]::ReadAllText($to, $utf8).TrimEnd()
                if ($body -notmatch '(?m)^Avatar:') {
                    [System.IO.File]::WriteAllText($to, $body + "`n" + $avatar.Line.TrimEnd() + "`n", $utf8)
                }
            }
        } else {
            Copy-Item $from $to -Force
        }
        Write-Host "OpenClaw -> $to"
    }
}
function Copy-Skill([string]$destRoot, [bool]$kebabName) {
    New-Item -ItemType Directory -Force $destRoot | Out-Null
    foreach ($dir in Get-ChildItem (Join-Path $Shared "skills") -Directory) {
        $dest = Join-Path $destRoot $dir.Name
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Copy-Item $dir.FullName $dest -Recurse -Force

        $file = Join-Path $dest "SKILL.md"
        $text = [System.IO.File]::ReadAllText($file, $utf8)
        if ($kebabName) {
            # 只改 frontmatter 里第一个 name 行
            $text = [regex]::Replace($text, '(?m)\A(---\r?\n(?:.*\r?\n)*?)name:[^\r\n]*', "`$1name: $($dir.Name)", 1)
        }
        # 小聪明儿没有读文件的工具（群里谁都能发消息，读文件不受沙箱限制，不能开），
        # 所以 references 里的细则直接并进 SKILL.md 末尾，加载技能时一起拿到
        $refDir = Join-Path $dest "references"
        if (Test-Path $refDir) {
            foreach ($ref in Get-ChildItem $refDir -Filter *.md | Sort-Object Name) {
                $body = [System.IO.File]::ReadAllText($ref.FullName, $utf8).TrimEnd()
                $text = $text.TrimEnd() + "`n`n---`n`n# 附：references/$($ref.Name)`n`n" + $body + "`n"
            }
            Remove-Item $refDir -Recurse -Force
        }
        [System.IO.File]::WriteAllText($file, $text, $utf8)
        Write-Host "技能 -> $dest"
    }
}

Copy-Skill (Join-Path $DshHome "skills") $true
if (Test-Path $OpenClawWorkspace) {
    Copy-Skill (Join-Path $OpenClawWorkspace "skills") $false
}
if (Test-Path $HermesHome) {
    Copy-Skill (Join-Path $HermesHome "skills") $true
}
