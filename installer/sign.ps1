# 给 dist 里的安装包做 Authenticode 签名
#
# 用法（拿到真证书之后）：
#   powershell -File installer\sign.ps1 -CertThumbprint "证书指纹"
#   powershell -File installer\sign.ps1 -CertPath "D:\cert\my.pfx"
#
# 先跑通链路、看看签名长什么样（不导入信任、不发给别人）：
#   powershell -File installer\sign.ps1 -SelfSigned
#
# ── 三条必须知道的事，改之前先读 ────────────────────────────────────────
# 1. 这个脚本**不能**让 Windows 信任你的安装包。信任来自 CA 对你身份的核验，
#    那是花钱/走流程买来的，脚本替不了。自签证书只在你自己机器上有效，
#    发给别人对方照样看到「Windows 已保护你的电脑」，而且比不签名更可疑
#    （还多了一个"证书不受信任"）。SelfSigned 开关存在的唯一目的：
#    在没有真证书的时候把整条链路（取证书 → 签名 → 校验）跑一遍。
# 2. 签名**不等于**立刻没有警告。OV/EV 都要靠"发布者信誉"积累，
#    2024 年起 EV 也不再有"首次下载即放行"的特权。签名真正的收益是：
#    UAC 上显示发布者名字、文件被篡改能被发现、杀软误报大幅下降，
#    以及后续版本能继承信誉 —— 而不是第一版就静默通过。
# 3. 用 PowerShell 自带的 Set-AuthenticodeSignature，不依赖 signtool / Windows SDK。
#    本机没装 SDK（查过了），硬要走的 Windows SDK 路线得先下几百 MB。

param(
    [string]$CertThumbprint,                              # 证书指纹（certmgr 里看）
    [string]$CertPath,                                    # 或 .pfx 文件路径
    [string]$CertPassword,                                # .pfx 的密码
    [string]$File,                                        # 要签的文件，默认取最新版本
    [string]$TimestampServer = 'http://timestamp.digicert.com',
    [switch]$SelfSigned,                                  # 演示：现做自签证书，跑完即删
    [switch]$NoTimestamp                                  # 自签证书加时间戳无意义，会自动跳过
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist'

# ---- 1. 确定签哪个文件 ----
if (-not $File) {
    [xml]$xml = Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Raw
    $ver = $xml.ExtensionManifest.ExtensionBundleVersion
    $File = Join-Path $dist "AIStudio-CEP-Setup-$ver.exe"
}
if (-not (Test-Path $File)) { throw "找不到要签名的文件：$File" }
"待签文件：$File"

# ---- 2. 取证书 ----
$tempCert = $null
try {
    if ($SelfSigned) {
        # 只放进 CurrentUser\My，**不**导入受信任根 —— 导入了就会污染本机信任库，
        # 而且让本机看起来"签好了"，实际上别人机器上毫无作用，属于自欺欺人。
        $tempCert = New-SelfSignedCertificate `
            -Subject 'CN=AI Studio (自签测试，勿信任)' `
            -Type CodeSigningCert `
            -CertStoreLocation 'Cert:\CurrentUser\My' `
            -HashAlgorithm SHA256 `
            -KeyLength 2048
        $cert = $tempCert
        "已生成临时自签证书：$($cert.Thumbprint)"
        "（只用于跑通链路，**不能**发给别人；脚本结束会删掉）"
        $NoTimestamp = $true
    }
    elseif ($CertThumbprint) {
        $cert = Get-ChildItem "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
        if (-not $cert) { $cert = Get-ChildItem "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue }
        if (-not $cert) { throw "在证书存储里找不到指纹为 $CertThumbprint 的证书（含私钥）" }
        "使用证书：$( $cert.Subject )"
    }
    elseif ($CertPath) {
        if (-not (Test-Path $CertPath)) { throw "找不到证书文件：$CertPath" }
        # PowerShell 5.1 里 if 不能当表达式用，只能写成显式分支（踩过）
        if ($CertPassword) {
            $securePwd = ConvertTo-SecureString $CertPassword -AsPlainText -Force
            $cert = Get-PfxCertificate -FilePath $CertPath -Password $securePwd
        } else {
            $cert = Get-PfxCertificate -FilePath $CertPath
        }
        "使用证书：$( $cert.Subject )"
    }
    else {
        throw @"
请指定证书。三种办法之一：

  -CertThumbprint "<指纹>"     证书已装到本机证书存储（USB token 插着时也能这样用）
  -CertPath "D:\cert\my.pfx"   用 .pfx 文件，配合 -CertPassword
  -SelfSigned                  临时自签一张，只用来跑通链路

还没有证书的话，见 installer/README.md 的「签名」一节：
SignPath Foundation（开源项目免费）、买 OV 证书（约 ￥1000-2000/年）、
或暂时不签而改用 SHA256 校验 + Unblock-File 的办法。
"@
    }

    # ---- 3. 签名 ----
    ''
    '签名中…'
    $args_ = @{ FilePath = $File; Certificate = $cert; HashAlgorithm = 'SHA256' }
    if (-not $NoTimestamp) { $args_.TimestampServer = $TimestampServer; "时间戳服务：$TimestampServer" }

    $sig = Set-AuthenticodeSignature @args_
    if ($sig.Status -eq 'Valid') { "签名状态：Valid" }
    else {
        # 自签证书链不受信任，这里必然不是 Valid —— 但签名本身写进去了。
        # 别把它当成功发出去，也别以为"状态不是 Valid 就是脚本坏了"。
        "签名状态：$($sig.Status)"
        if ($SelfSigned) { '（自签证书不受信任，这是**预期**结果；下面只验证签名写进去了）' }
    }

    # ---- 4. 校验：签名到底在不在文件里 ----
    ''
    '校验…'
    $check = Get-AuthenticodeSignature -FilePath $File
    $ok = ($null -ne $check.SignerCertificate) -and
          ($check.SignerCertificate.Thumbprint -eq $cert.Thumbprint)
    if ($ok) {
        "  OK  文件里的签名证书 = 我们指定的证书（$($check.SignerCertificate.Thumbprint)）"
        "      发布者：$($check.SignerCertificate.Subject)"
    } else {
        "  FAIL 文件里的签名对不上（SignerCertificate=$($check.SignerCertificate)）"
    }

    # ---- 5. 顺带给出 SHA256，发给别人时让人能验完整性 ----
    ''
    $hash = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    "SHA256: $hash"
    "把这个值贴到发布页，对方用 certutil -hashfile <文件> SHA256 就能核对。"

    if (-not $ok) { exit 1 }
    if (-not $SelfSigned -and $sig.Status -ne 'Valid') {
        "注意：签名写进去了，但状态是 $($sig.Status)。"
        '真证书出现这个状态，通常是时间戳服务连不上 —— 换个时间戳服务器再试：'
        '  http://timestamp.sectigo.com    http://tsa.starfieldtech.com'
        exit 1
    }
} finally {
    # ---- 6. 清理临时证书 ----
    if ($tempCert) {
        Remove-Item "Cert:\CurrentUser\My\$($tempCert.Thumbprint)" -Force -ErrorAction SilentlyContinue
        '临时自签证书已删除'
    }
}
