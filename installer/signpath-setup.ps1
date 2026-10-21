# SignPath 审核通过后，一条命令配好 GitHub 侧的凭证
#
#   powershell -File installer\signpath-setup.ps1 -OrganizationId "<Org ID>"
#   powershell -File installer\signpath-setup.ps1 -OrganizationId "<Org ID>" -DryRun
#
# 会依次做：
#   1. 写 secret  SIGNPATH_API_TOKEN
#   2. 写 variable SIGNPATH_ORGANIZATION_ID
#   3. 校验 workflow 里的三个 slug 是否写全
#   4. 告诉你下一步该干嘛
#
# 为什么要有这个脚本：这三样东西分散在 GitHub 的两个页面（Secrets / Variables）
# 和 SignPath 控制台的三处配置里，手点很容易一边名字对不上、另一边 slug 对不上，
# 然后 CI 静默跳过签名 —— 流水线全绿，发出去的却还是没签名的包。
#
# Token 不打印、不落盘。不传 -Token 时会从提示符读（不回显）。
#
# -DryRun：只做第 3 步的校验，加上把要写的名字念一遍，不碰仓库、不要 Token。
#          用来在拿到 SignPath 凭证之前先确认脚本本身和 workflow 是对的。

param(
    [string]$OrganizationId = '',
    [string]$Token,
    [string]$Repo = 'xy952193312-creator/ai-studio-cep',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

if (-not $DryRun -and -not $OrganizationId) {
    throw '缺 -OrganizationId（SignPath 控制台 Organization settings 里的 GUID）'
}
if ($DryRun -and -not $OrganizationId) { $OrganizationId = '<dry-run-占位>' }

# ---- 定位 gh ----
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $cand = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (Test-Path $cand) { $gh = $cand }
}
if (-not $gh) {
    if ($DryRun) { $gh = $null } else { throw '找不到 gh。先装：winget install --id GitHub.cli -e' }
}

"仓库：$Repo"
"Organization ID：$OrganizationId"
if ($DryRun) { '模式：DRY RUN —— 不写任何 secret/variable' }
''

# ---- 0. 前置：gh 是否已登录 ----
if ($gh) {
    & $gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        if ($DryRun) { '警告：gh 没登录，正式跑之前要先 gh auth login' }
        else { throw 'gh 还没登录，先跑 gh auth login' }
    }
}

# ---- 1. secret ----
if ($DryRun) {
    # 5.1 没有三元运算符，显式分支
    $src = '运行时从提示符读，不回显'
    if ($Token) { $src = '来自 -Token' }
    "  [跳过] 将写入 secret   SIGNPATH_API_TOKEN（$src）"
} else {
    if (-not $Token) {
        $sec = Read-Host 'SignPath API Token（输入时不回显）' -AsSecureString
        $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    if (-not $Token) { throw 'Token 是空的' }
    $Token | & $gh secret set SIGNPATH_API_TOKEN -R $Repo
    if ($LASTEXITCODE -ne 0) { throw '写 secret 失败' }
    '  已写入 secret SIGNPATH_API_TOKEN'
}

# ---- 2. variable ----
if ($DryRun) {
    "  [跳过] 将写入 variable SIGNPATH_ORGANIZATION_ID = $OrganizationId"
} else {
    & $gh variable set SIGNPATH_ORGANIZATION_ID -R $Repo --body $OrganizationId
    if ($LASTEXITCODE -ne 0) { throw '写 variable 失败' }
    '  已写入 variable SIGNPATH_ORGANIZATION_ID'
}

# ---- 3. 校验 workflow ----
# 下面每一项对不上，签名请求都会被拒；更糟的是工作流因为 if 判断仍然"成功"跑完，
# 只是跳过了签名 —— 所以这里必须逐项查，不能只看有没有报错。
$wfPath = Join-Path $root '.github\workflows\release.yml'
if (-not (Test-Path $wfPath)) { throw "找不到 workflow：$wfPath" }
$wf = Get-Content $wfPath -Raw

$fail = 0
function Ck($name, $ok, $detail) {
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    "  $mark $name $detail"
    if (-not $ok) { $script:fail++ }
}

''
'workflow 校验：'

$slugs = [ordered]@{
    'project-slug'                = 'ai-studio-cep'
    'signing-policy-slug'         = 'release-signing'
    'artifact-configuration-slug' = 'setup-exe'
}
foreach ($k in $slugs.Keys) {
    $pat = [regex]::Escape($k) + "\s*:\s*'" + [regex]::Escape($slugs[$k]) + "'"
    Ck $k ($wf -match $pat) "= $($slugs[$k])"
}

# 变量名叫错，if 判断就永远是 false，签名整段被静默跳过
Ck '签名步骤有 vars.SIGNPATH_ORGANIZATION_ID 守卫' ($wf -match 'vars\.SIGNPATH_ORGANIZATION_ID') ''
# secret 名要和上面第 1 步写的一致
Ck '引用了 secrets.SIGNPATH_API_TOKEN' ($wf -match 'secrets\.SIGNPATH_API_TOKEN') ''
# 签完必须验，否则 token 过期也发现不了
Ck '校验 Authenticode（Status 必须 Valid）' ($wf -match 'Get-AuthenticodeSignature') ''
# 签名会改变文件字节，说明书里的 SHA256 必须在签名之后算
$iSign = $wf.IndexOf('Get-AuthenticodeSignature')
$iGuide = $wf.IndexOf('make-userguide.ps1')
Ck '安装说明在签名之后生成' ($iGuide -ge 0 -and $iSign -ge 0 -and $iGuide -gt $iSign) ''

''
if ($fail -gt 0) { throw "$fail 项校验失败，先修 workflow 再配置凭证" }
'全部通过'

# ---- 4. 下一步 ----
''
if ($DryRun) {
    'DRY RUN 结束：脚本本身没问题，等 SignPath 审核过了再去掉 -DryRun 正式跑。'
    exit 0
}

'接下来：'
'  1. 到 SignPath 控制台确认这三项都建好了，且 GitHub Actions Trusted Build 已启用：'
'       Project              ai-studio-cep'
'       Signing policy       release-signing'
'       Artifact config      setup-exe（根元素必须是 zip）'
'  2. 打一个新 tag 触发签名（不要复用 v1.2.14，它已经发过未签名包）：'
'       git tag v1.2.15 ; git push --tags'
'     push 不通的话用 workflow_dispatch 指定 tag：'
'       gh workflow run release --ref v1.2.15'
'  3. 跑完看 Actions 里「校验签名并生成安装说明」这一步，'
'     必须打印出 "签名状态 : Valid" —— 不是 Valid 就是没签上。'
