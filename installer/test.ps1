# 安装程序的端到端测试（用的是测试专用 AppId 和目录，不会碰真装的插件）
#
#   powershell -ExecutionPolicy Bypass -File installer\test.ps1
#
# 覆盖的五件事：
#   1. 文件确实装到 CEP 扩展目录，且 .debug 没被带进去（那是开发用的）
#   2. PlayerDebugMode 真的是安装程序写进去的（先把一个键改成 0，装完应该变 1）
#   3. **用户取消勾选时绝对不写注册表** —— 这条是安全相关，必须自动化验证，
#      不然它永远只有代码审查看着
#   4. 卸载能删干净（程序和卸载项），且不碰别的地方
#   5. **PS 探测真的执行了** —— 曾经这条完全没测，于是"探测函数写了却没人调用、
#      界面永远显示没找到 PS"一路绿灯发到了用户手里。断言靠安装日志里的
#      「PS 探测结果：N 个」，只要函数没接线就必然失败。

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 遇到大小写重复的代理变量会直接崩，先清掉
foreach ($v in @('http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY')) {
    if (Test-Path "Env:\$v") { Remove-Item "Env:\$v" -Force }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$iss  = Join-Path $here 'ai-studio.iss'
$dist = Join-Path $root 'dist'

# 测试专用的 AppId / 目录名，和真实安装完全隔离
# AppId 的括号：左双右单（Inno 的常量转义规则），写成左右都双会多出一个 }
$testId    = '11111111-2222-3333-4444-555555555555'
$testIdIss = "{{$testId}"
$testName  = 'com.xy.aistudio.cep.test'
$testDir   = Join-Path $env:APPDATA "Adobe\CEP\extensions\$testName"
# Inno 的卸载项是 "<AppId 含大括号>_is1"
$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{$testId}_is1"

# 挑一个没有任何 PS 版本对应的键来折腾：PS 2025 用的是 CSXS.12，
# CSXS.20 动了不会影响任何已装扩展，测完再恢复原值
$probeKey = 'HKCU:\Software\Adobe\CSXS.20'
$probeVal = 'PlayerDebugMode'

$results = @()
function ck($name, $cond, $extra) {
    $script:results += [pscustomobject]@{ ok = [bool]$cond; name = $name; extra = "$extra" }
    $mark = if ($cond) { 'PASS' } else { 'FAIL' }
    "  $mark  $name$(if ($extra) { "  -> $extra" })"
}

function Set-Probe($v) {
    if (-not (Test-Path $probeKey)) { New-Item -Path $probeKey -Force | Out-Null }
    Set-ItemProperty -Path $probeKey -Name $probeVal -Value $v -Type DWord
}
function Get-Probe {
    try { (Get-ItemProperty -Path $probeKey -Name $probeVal -ErrorAction Stop).$probeVal }
    catch { $null }
}

# ---- 前置：编译测试版 ----
'编译测试版安装程序…'
$iscc = Join-Path $root 'tools\_is\is\ISCC.exe'
if (-not (Test-Path $iscc)) { throw "没找到 ISCC.exe：$iscc" }

[xml]$m = Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Raw
$ver = $m.ExtensionManifest.ExtensionBundleVersion

$out = Join-Path $dist "test-setup.exe"
& $iscc "/DMyAppVersion=$ver" "/DMyAppId=$testIdIss" "/DMyDestName=$testName" "/O$dist" "/Ftest-setup" $iss | Out-Null
if ($LASTEXITCODE -ne 0) { throw "测试版编译失败" }
if (-not (Test-Path $out)) { throw "没产出 $out" }
"  测试版：$out"

$origProbe = Get-Probe
"  CSXS.20 原值：$origProbe（测完会恢复）"

# 期望文件数 = 源码里除 .debug 外的文件 + 2（Inno 自己放的 unins000.exe / .dat）
$wantFiles = (Get-ChildItem (Join-Path $root 'extension') -Recurse -File |
              Where-Object { $_.Name -ne '.debug' }).Count + 2

# ---- 前置清理：上一轮崩掉或手动跑过留下的东西必须清干净，
#      否则 Inno 会装出 unins001.exe，文件数和卸载断言全乱 ----
if (Test-Path $testDir) { Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $uninstKey) { Remove-Item $uninstKey -Recurse -Force -ErrorAction SilentlyContinue }
'  已清理可能的残留'

try {

    # ========== 第 1 轮：正常安装（同意开启） ==========
    ''
    '── 第 1 轮：正常安装 ──'
    Set-Probe 0
    ck '前置：探测键已置 0' ((Get-Probe) -eq 0) "现在是 $(Get-Probe)"

    $log = Join-Path $env:TEMP 'aistudio-install-test.log'
    if (Test-Path $log) { Remove-Item $log -Force }
    # /LOG 必须排在参数第一位：/TASKS="" 会把后面的参数一起吞掉（踩过）
    $p = Start-Process -FilePath $out -ArgumentList "/LOG=$log",'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
    ck '静默安装退出码 0' ($p.ExitCode -eq 0) "退出码 $($p.ExitCode)"

    ck '扩展目录建出来了' (Test-Path $testDir) $testDir
    $got = if (Test-Path $testDir) { (Get-ChildItem $testDir -Recurse -File).Count } else { 0 }
    ck "文件数对得上（期望 $wantFiles）" ($got -eq $wantFiles) "实际 $got 个"

    foreach ($f in @('index.html','CSXS\manifest.xml','js\api.js','jsx\host.jsx','css\app.css')) {
        ck "关键文件在：$f" (Test-Path (Join-Path $testDir $f)) ''
    }
    ck '.debug 没有被带进安装包' (-not (Test-Path (Join-Path $testDir '.debug'))) '（开发用的，不该发给用户）'

    ck 'PlayerDebugMode 被写成 1' ((Get-Probe) -eq 1) "现在 $(Get-Probe)"
    ck '卸载项登记了' (Test-Path $uninstKey) $uninstKey

    # ========== PS 探测（曾经漏测，导致"函数写了没被调用"上线） ==========
    ''
    '── PS 探测 ──'
    $logText = if (Test-Path $log) { Get-Content $log -Encoding UTF8 -Raw } else { '' }
    ck '安装日志生成了' ($logText -ne '') $log

    # 这条断言的意义不在"找到几个"，而在"探测函数真的被调用过"。
    # 之前 DetectPhotoshop 定义了却没人调，界面永远显示"没找到"，
    # 而所有文件/注册表断言照样全绿 —— 只有这条能拦住。
    $mm = [regex]::Match($logText, 'PS 探测结果：(\d+) 个')
    ck '探测函数被调用了（日志有「PS 探测结果」）' $mm.Success ''
    $found = if ($mm.Success) { [int]$mm.Groups[1].Value } else { -1 }

    # 本机注册表里有几个带 ApplicationPath 的 PS，就至少该探测到几个
    $regPS = @(Get-ChildItem 'HKLM:\SOFTWARE\Adobe\Photoshop' -ErrorAction SilentlyContinue |
               Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ApplicationPath })
    if ($regPS.Count -gt 0) {
        ck "本机注册表有 $($regPS.Count) 个 PS，探测数应 ≥ 1" ($found -ge 1) "探测到 $found 个"
    } else {
        ck '本机注册表没有 PS，探测数应为 0' ($found -eq 0) "探测到 $found 个"
    }

    # 第一页的正文必须渲染得出来（BuildPSReport 抛异常的话这里是空的）
    ck '第一页正文已生成' ($logText -match 'PS 报告预览：\s*\S') ''

    # ========== 卸载 ==========
    ''
    '── 卸载 ──'
    $un = Join-Path $testDir 'unins000.exe'
    ck '卸载程序在' (Test-Path $un) $un
    if (Test-Path $un) {
        $p = Start-Process -FilePath $un -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
        ck '静默卸载退出码 0' ($p.ExitCode -eq 0) "退出码 $($p.ExitCode)"
    }
    $dirGone = if (Test-Path $testDir) { '还在' } else { '已删' }
    ck '扩展目录已删掉' (-not (Test-Path $testDir)) $dirGone
    ck '卸载项已注销' (-not (Test-Path $uninstKey)) ''

    # ========== 第 2 轮：用户取消勾选 ==========
    ''
    '── 第 2 轮：用户取消勾选，绝不能写注册表 ──'
    Set-Probe 0
    ck '前置：探测键已置 0' ((Get-Probe) -eq 0) "现在是 $(Get-Probe)"

    # /TASKS= 传空 = 一个任务都不选，等价于用户取消了勾选。
    # 这是 Inno 原生支持的，静默模式下也生效。
    $p = Start-Process -FilePath $out -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS="' -Wait -PassThru
    ck '静默安装退出码 0' ($p.ExitCode -eq 0) "退出码 $($p.ExitCode)"

    ck '文件照样装好了' (Test-Path (Join-Path $testDir 'index.html')) ''
    ck 'PlayerDebugMode 仍是 0（没被偷偷改）' ((Get-Probe) -eq 0) "现在 $(Get-Probe)"

    # 清理第 2 轮
    $un = Join-Path $testDir 'unins000.exe'
    if (Test-Path $un) {
        Start-Process -FilePath $un -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait | Out-Null
    }
    ck '第 2 轮也卸载干净了' (-not (Test-Path $testDir)) ''

} finally {
    # ---- 恢复现场 ----
    ''
    '── 恢复现场 ──'
    if ($null -ne $origProbe) { Set-Probe $origProbe; "  CSXS.20 已恢复为 $origProbe" }
    else { "  CSXS.20 原本不存在，跳过恢复" }
    if (Test-Path $testDir) { Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue; "  清掉残留测试目录" }
    if (Test-Path $uninstKey) { Remove-Item $uninstKey -Recurse -Force -ErrorAction SilentlyContinue; "  清掉残留卸载项" }
}

# ---- 汇总 ----
''
$pass = ($results | Where-Object ok).Count
$fail = ($results | Where-Object { -not $_.ok }).Count
if ($fail -gt 0) {
    '失败的项：'
    $results | Where-Object { -not $_.ok } | ForEach-Object { "  · $($_.name)  $($_.extra)" }
    ''
}
if ($fail -eq 0) { "全部通过（$pass 项）"; exit 0 }
else { "$fail 项失败（通过 $pass 项）"; exit 1 }
