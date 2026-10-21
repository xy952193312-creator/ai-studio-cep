# 构建 AI Studio 的 EXE 安装程序
#
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1
#
# 做的事：
#   1. 从 extension\CSXS\manifest.xml 读出版本号（唯一真源，避免两处不同步）
#   2. 找到 ISCC.exe（优先用项目内那份解压出来的，其次系统装的）
#   3. 编译 installer\ai-studio.iss → dist\AIStudio-CEP-Setup-<版本>.exe
#
# 校验安装器真伪：官方包有 Pyrsys B.V. 签名、约 13MB。
# 别用 curl 从 GitHub 下 —— 有些代理会塞回来一个 588KB 的假 exe，
# 签名是 NotSigned，跑起来直接报"不是有效的应用程序"。

param(
    [string]$Iscc = '',
    [switch]$SkipVersionCheck
)

$ErrorActionPreference = 'Stop'

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $here
$iss   = Join-Path $here 'ai-studio.iss'
$dist  = Join-Path $root 'dist'

# ---- 1. 读版本号 ----
$manifest = Join-Path $root 'extension\CSXS\manifest.xml'
if (-not (Test-Path $manifest)) { throw "找不到 $manifest" }

[xml]$xml = Get-Content $manifest -Raw
$ver = $xml.ExtensionManifest.ExtensionBundleVersion
$extVer = $xml.ExtensionManifest.ExtensionList.Extension.Version

if (-not $ver) { throw "manifest.xml 里读不到 ExtensionBundleVersion" }
if ($ver -ne $extVer) {
    throw "manifest 里两处版本不一致：ExtensionBundleVersion=$ver / Extension Version=$extVer（必须同步改）"
}
"版本号：$ver（来自 manifest.xml）"

# ---- 2. 找 ISCC ----
if (-not $Iscc) {
    $cands = @(
        (Join-Path $root 'tools\_is\is\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) { $Iscc = $c; break }
    }
}
if (-not $Iscc -or -not (Test-Path $Iscc)) {
    throw @"
没找到 ISCC.exe（Inno Setup 编译器）。

两种办法之一：
  1) winget download --id JRSoftware.InnoSetup.7 -e -d tools\_is
     然后把解压出来的 ISCC.exe 所在目录指进来：
       powershell -File installer\build.ps1 -Iscc "<路径>\ISCC.exe"
  2) 直接装 Inno Setup 7（https://jrsoftware.org/isdl.php），本脚本会自动找到
"@
}
"编译器：$Iscc"

# ---- 3. 编译 ----
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

& $Iscc "/DMyAppVersion=$ver" "/O$dist" $iss
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译失败，退出码 $LASTEXITCODE" }

# ---- 4. 报告 ----
$out = Join-Path $dist "AIStudio-CEP-Setup-$ver.exe"
if (Test-Path $out) {
    $size = [math]::Round((Get-Item $out).Length / 1MB, 2)
    ""
    "产出：$out"
    "大小：$size MB"
} else {
    throw "编译说成功了，但没找到 $out"
}

# ---- 5. 随包生成安装说明（版本号和 SHA256 在这里落定） ----
# 单独一个脚本，因为 CI 里签名之后还要再跑一次 —— 签名会改变文件，
# 哈希也跟着变，说明里的校验值必须是最终那个文件的。
& (Join-Path $here 'make-userguide.ps1') -Exe $out
