# 把小聪明儿的人设和技能同步给 dsh 的 xbot profile。改过 SOUL.md 或技能后重跑一遍即可，不用重启。
#
#   .\sync-assets.ps1
#
# 人设  -> $DSH_HOME\profiles\<profile>\SOUL.md（profile 的 system-prompt.personaPrefix 读它）
# 技能  -> $DSH_HOME\skills\<名字>\（dsh 的用户级技能目录，不分工作区都能看到；dsh 要求 name 是 kebab-case，共用技能的中文名在副本里改成目录名）
#
# 源文件在 xchatbot\.docs\agent\shared，这里只复制，不改源。

param(
    [string]$Shared = "D:\Workspace\mygithub\xchatbot\.docs\agent\shared",
    [string]$ProfileName = "xbot",
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" })
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)

$profileDir = Join-Path $DshHome "profiles\$ProfileName"
if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir（先 dsh plugin --profile $ProfileName add …）" }

Copy-Item (Join-Path $Shared "SOUL.md") (Join-Path $profileDir "SOUL.md") -Force
Write-Host "人设 -> $profileDir\SOUL.md"
$skillRoot = Join-Path $DshHome "skills"
New-Item -ItemType Directory -Force $skillRoot | Out-Null

foreach ($dir in Get-ChildItem (Join-Path $Shared "skills") -Directory) {
    $dest = Join-Path $skillRoot $dir.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $dir.FullName $dest -Recurse -Force

    $file = Join-Path $dest "SKILL.md"
    $text = [System.IO.File]::ReadAllText($file, $utf8)
    # 只改 frontmatter 里第一个 name 行
    $fixed = [regex]::Replace($text, '(?m)\A(---\r?\n(?:.*\r?\n)*?)name:[^\r\n]*', "`$1name: $($dir.Name)", 1)
    # 小聪明儿没有读文件的工具（群里谁都能发消息，读文件不受沙箱限制，不能开），
    # 所以 references 里的细则直接并进 SKILL.md 末尾，加载技能时一起拿到
    $refDir = Join-Path $dest "references"
    if (Test-Path $refDir) {
        foreach ($ref in Get-ChildItem $refDir -Filter *.md | Sort-Object Name) {
            $body = [System.IO.File]::ReadAllText($ref.FullName, $utf8).TrimEnd()
            $fixed = $fixed.TrimEnd() + "`n`n---`n`n# 附：references/$($ref.Name)`n`n" + $body + "`n"
        }
        Remove-Item $refDir -Recurse -Force
    }
    [System.IO.File]::WriteAllText($file, $fixed, $utf8)
    Write-Host "技能 -> $dest"
}
