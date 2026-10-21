# 安装程序（EXE）构建与发布

把 `extension/` 那 26 个文件做成一个能装能卸的 exe。
产物：`dist\AIStudio-CEP-Setup-<版本>.exe`（约 2.1 MB）

## 构建

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

版本号从 `extension/CSXS/manifest.xml` 读，不另外维护。
manifest 里两处版本不一致时脚本会直接报错退出。

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File installer\test.ps1
```

25 项，全程用**测试专用 AppId 和目录**（`com.xy.aistudio.cep.test`），
不会碰到你真装的那份。跑完自动清理并恢复被改过的注册表值。

覆盖的关键点：

| 断言 | 为什么值得测 |
|---|---|
| 文件数 = 源码数 + 2 | 卸载程序自己会放 `unins000.exe`/`.dat` |
| `.debug` 没被带进去 | 那是开发用的固定调试端口，不该发给用户 |
| `PlayerDebugMode` 从 0 变 1 | 证明是**安装程序**写的，不是本来就有 |
| 取消勾选后仍是 0 | 安全分支：用户不同意就绝不能偷偷改注册表 |
| 卸载后目录和卸载项都消失 | 卸载要干净 |
| **日志里有「PS 探测结果」** | 防"函数写了却没人调用"——v1.2.13 就这么漏的 |
| **探测数 ≥ 本机注册表里的 PS 数** | 防"探测跑了但扫了个空"（32 位模式下 `{pf}` 指向 Program Files (x86)） |

反向验证过三条：把 `WizardIsTaskSelected` 改成恒真 → 1 项失败；
去掉 `Excludes: ".debug"` → 2 项失败；注释掉 `DetectPhotoshop;` → 2 项失败。

## 设计约束（改之前先读）

1. **全程只碰 `HKCU` + `%APPDATA%`**，所以不需要管理员、不弹 UAC。
   别改成装到 Program Files —— 那会引入提权，而收益只有"看起来正规"。
2. **`PlayerDebugMode` 必须由用户明确同意后才写**，而且要讲清它是全局开关
   （对本机所有未签名扩展生效，不只我们这个）。
3. **卸载只删程序文件**。历史记录、API Key、资料库一律保留。
4. **装完必须重启 PS**，新装的 CEP 扩展不会热加载。
5. **必须设 `ArchitecturesInstallIn64BitMode=x64compatible`**。不设的话安装器跑在
   32 位模式，`{pf}` 会变成 `C:\Program Files (x86)`（PS 装在 `Program Files`），
   而且 `HKLM` 被重定向到 `WOW6432Node`（那下面没有 `Adobe\Photoshop`）——
   两头都扫空，报"没找到 Photoshop"。实测日志：不设 → `pf="C:\Program Files (x86)"`。
6. **探测结果必须写 `Log`**。没有日志，"为什么没找到 PS" 只能靠猜；
   v1.2.13 的事故里界面和日志都一片安静，白白绕了一大圈。

## 签名：免费能拿到真签名吗

能，但只有一条路，而且要拿"源码公开"来换。先纠正三个容易搞错的点。

**1. 签名 ≠ 立刻不报警。**
微软 2024 年起取消了 EV 证书"首次下载即放行"的特权，OV 和 EV 现在都要靠
**发布者信誉**积累 —— 同一个签名身份连续签几个版本、下载量上去之后警告才消失。
签名真正的收益是：UAC 上显示发布者名字、文件被篡改能被发现、
杀软误报大幅下降、后续版本继承信誉。**不是第一版就静默通过。**

**2. Azure Artifact Signing（原 Trusted Signing）$9.99/月，中国大陆个人开发者用不了。**
个人身份只限美国和加拿大；组织限美/加/欧盟/英国，且要求 3 年以上可验证税务历史。
网上教程普遍推荐它，但很少提这个地理限制。

**3. 自签证书不能发给别人。**
它只在你自己机器上（把根证书导入信任库后）有效；对方机器上反而多一个
"证书不受信任"，比不签名更可疑。`sign.ps1 -SelfSigned` 的唯一用途
是在没有真证书时把链路跑通，别拿它签出来发出去。

### 免费方案：SignPath Foundation（真签名，前提开源）

给符合条件的开源项目免费签发 OV 级代码签名证书，私钥存在他们的 HSM 上，
接 GitHub Actions 自动签。代价：**发布者名字是 "SignPath Foundation"**，不是你。

条件（signpath.org/terms）：

- OSI 批准的开源许可证，代码在公开仓库（GitHub）
- 项目已发布、活跃维护、**不含任何专有代码**
- 构建是可审查的自动 CI（GitHub Actions）
- 团队成员都要开 MFA，每次签名要有人审批
- 人工审核，通过才给

代码本身具备条件：全仓库没有硬编码密钥，API 地址由使用者自己填
（`grep -riE "(api_key|secret|token|password)" extension/` → 无匹配）。
**要不要公开仓库是商业决定，不是技术问题。**

### 花钱方案（不开源也要真签名）

OV = Organization Validation，需要**营业执照**（公司或个体工商户）。
2026 年国内行情（多个渠道报价，含代理商）：

| 品牌 | 约价/年 | 交付方式 |
|---|---|---|
| Certum OV | ~800 元 | 云签名，不用等 UKey 邮寄 |
| GlobalSign OV | ~1500–2000 元 | UKey 国内寄 |
| Sectigo OV | ~3200 元 | UKey 国际寄 |
| DigiCert OV | ~4600 元 | UKey 国际寄 |

### 技术链路已经跑通：sign.ps1

拿到证书后一条命令就签：

```powershell
powershell -File installer\sign.ps1 -CertThumbprint "<证书指纹>"
powershell -File installer\sign.ps1 -CertPath "D:\cert\my.pfx"
```

用 PowerShell 自带的 `Set-AuthenticodeSignature`，**不依赖 signtool / Windows SDK**
（本机查过没装 SDK，走 Windows SDK 路线得先下几百 MB）。
没有证书时先跑 `powershell -File installer\sign.ps1 -SelfSigned` 验证链路。

### SignPath 审核通过后：signpath-setup.ps1

凭证明面上是三样东西，散在 GitHub 的 Secrets / Variables 两页和 SignPath 控制台三处，
手点很容易一边名字对不上、另一边 slug 对不上 —— 然后 CI 静默跳过签名，流水线全绿，
发出去的却是没签名的包。这个脚本就是把这堆一次配齐并当场校验：

```powershell
# 先空跑，确认脚本本身和 workflow 都没问题（不写任何东西、不要 Token）
powershell -File installer\signpath-setup.ps1 -OrganizationId 占位 -DryRun

# 拿到 SignPath 凭证后正式跑（Token 从提示符读，不回显）
powershell -File installer\signpath-setup.ps1 -OrganizationId "<Organization ID>"
```

`-DryRun` 会逐项检查 7 条，其中几条是「错了也不报错、只会静默不签名」的类型：
三个 slug、`vars.SIGNPATH_ORGANIZATION_ID` 守卫、`secrets.SIGNPATH_API_TOKEN` 名、
以及「安装说明必须在签名之后生成」（签名会改变文件字节，SHA256 得算签名后的）。

### 一分钱不花的缓解办法

`dist\install-guide.txt` —— 把这个文件连同 exe 一起发给对方即可
（文件名用 ASCII：GitHub 会把中文 asset 名改成 `default.txt`）：

- 附 SHA256 校验值，让对方能自己确认文件没被动过
- 教对方右键 → 属性 → 勾选「解除锁定」，一次就消掉 SmartScreen 那层拦截
- 讲清为什么要重启 PS、改了哪个注册表项

## 发给别人之前，三件要说清的事

**一、Windows SmartScreen 会拦。**

这个 exe 没有代码签名证书，所以对方双击时大概率看到
「Windows 已保护你的电脑」，要选「更多信息 → 仍要运行」。
这不是程序有问题，是"没签名"这件事本身的代价。
可选的路（免费开源换签名 / 买 OV 证书 / 用安装说明缓解）见上一节。

**二、杀毒软件可能误报。**

Inno 生成的安装器偶发被报 `Win32:Malware-gen` 之类，属于启发式误报常见形态。
真要分发，可考虑上传到 VirusTotal 自查一遍，把报告一起给对方。

**三、安装会改注册表。**

`HKCU\Software\Adobe\CSXS.9` ~ `CSXS.20` 的 `PlayerDebugMode` 会被设成 1。
安装向导里有专门一页讲这件事，任务页的复选框默认勾着但可以取消。
**如果对方在受控环境（公司电脑、有 IT 策略），先问一句再装。**

## 已知的坑（都是踩出来的，别再踩）

| 现象 | 原因 |
|---|---|
| 编译报 `Unknown preprocessor directive` | ISPP 把**行首**的 `#` 当指令。Pascal 里的 `#13#10` 续行后正好落在行首就会中招 → 用常量 `NL` 代替 |
| 编译报 `Unknown constant "..."` | `AppId` 的 GUID 要写成**左双右单**（左边两个左花括号、右边一个），写成左右都双会多出一个右括号，卸载项 key 对不上 |
| 注释里的 `{...}` 也报错 | Inno 连注释里的花括号都当常量解析 → 注释里别写花括号 |
| 静默安装卡死不动 | 在 `NextButtonClick` 里弹的确认框，静默模式下没人点。所有在 `[Code]` 里的 `MsgBox` 都要先判 `WizardSilent` / `UninstallSilent` |
| 命令行参数传不进 `[Code]` | 实测三个都不行：`{param:}` 常量读不到、`GetCmdTail` 返回的是内部 `/SL5=...` 串、`GetEnv` 也读不到 → 用 Inno 原生 `[Tasks]`，`/TASKS=` 能可靠控制 |
| `.ps1` 里的中文变乱码 | PowerShell 5.1 按 ANSI 读无 BOM 文件 → 脚本必须存成 **UTF-8 with BOM** |

## 卸载

两种入口：

- 「设置 → 应用 → 已安装的应用」里找 **AI Studio 1.2.13（Photoshop 面板）**
- 或直接跑 `<扩展目录>\unins000.exe`

卸载只删程序文件。数据保留位置：

- 资料库目录（生成的图与对话）—— 面板「我的 → 存储位置」里能看到路径
- API Key 与模型配置 —— 面板「我的」页有「清除已保存的 Key」
