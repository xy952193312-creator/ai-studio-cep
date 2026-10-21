# 生成最终的安装说明（替换模板里的版本号和 SHA256）
#
#   powershell -File installer\make-userguide.ps1
#   powershell -File installer\make-userguide.ps1 -Exe "签名后的文件.exe"
#
# 为什么必须做成模板 + 生成，而不是直接写死在文件里：
#   1. 版本号每次发版都变，手改迟早漏；
#   2. **签名会改变文件本身**，所以 SHA256 只能在签名之后算。
#      签名前算出来的值贴给用户，用户一核对发现对不上，
#      等于亲手制造一个"这文件被动过"的假警报。
#   所以 CI 里这一步放在 SignPath 签名**之后**跑。

param(
    [string]$Exe
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist'

$tpl      = Join-Path $here '安装说明-模板.txt'
$manifest = Join-Path $root 'extension\CSXS\manifest.xml'
if (-not (Test-Path $tpl))      { throw "找不到模板：$tpl" }
if (-not (Test-Path $manifest)) { throw "找不到 $manifest" }

[xml]$xml = Get-Content $manifest -Raw
$ver = $xml.ExtensionManifest.ExtensionBundleVersion

if (-not $Exe) { $Exe = Join-Path $dist "AIStudio-CEP-Setup-$ver.exe" }
if (-not (Test-Path $Exe)) { throw "找不到要写进说明的安装包：$Exe" }

$sha = (Get-FileHash -Path $Exe -Algorithm SHA256).Hash.ToLower()
$sizeMB = [math]::Round((Get-Item $Exe).Length / 1MB, 2)

$text = [IO.File]::ReadAllText($tpl, (New-Object Text.UTF8Encoding $false))
$text = $text.Replace('__VERSION__', $ver).Replace('__SHA256__', $sha)

# 版本号和哈希都得真替换掉，漏一个就是发给用户的文档在说谎
if ($text -match '__VERSION__|__SHA256__') { throw '模板里还有没替换掉的占位符' }
if ($sha.Length -ne 64) { throw "算出来的 SHA256 长度不对（$($sha.Length)）" }

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
# 文件名用 ASCII：GitHub Release 会把非 ASCII 的 asset 名改成 default.txt，
# 用户下载下来看到一个 default.txt 完全不知道是什么东西。
$out = Join-Path $dist 'install-guide.txt'
[IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding $false))

"已生成：$out"
"  版本 $ver / $sizeMB MB / SHA256 $sha"
