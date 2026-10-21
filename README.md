# AI Studio · Photoshop CEP 插件

**v1.2.14（正式版）** · 四页式 AI 生图面板：**智能改图 / AI 生图 / 历史记录 / 我的（自定义 API 配置）**。
深色 UI，0 依赖，无构建步骤，拷进目录即可用。

> 所有出图请求发往**你自己填写的 API 地址** —— 工程内不硬编码任何第三方接口或密钥。

## 安装包（EXE）

不想手动拷目录的话，可以直接用打好的安装程序：

```
dist\AIStudio-CEP-Setup-1.2.14.exe    2.1 MB
```

- **不需要管理员**，不弹 UAC —— 全程只写 `HKCU` 和 `%APPDATA%`
- 会自动扫出本机所有 Photoshop 版本（注册表 + 安装目录两条路），版本过低会明确标出来
- 会讲清楚要开哪个注册表开关、为什么开，**勾选了才写**
- 卸载只删程序文件，历史记录 / API Key / 资料库全部保留

重新构建和发布注意事项见 [`installer/README.md`](installer/README.md)。
测试：`powershell -File installer\test.ps1`（25 项，用隔离的 AppId，不碰你真装的那份）。

**下载**：<https://github.com/xy952193312-creator/ai-studio-cep/releases/latest>

## Code signing policy

**Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).**

- Committers and reviewers: [@xy952193312-creator](https://github.com/xy952193312-creator) (project owner)
- Approvers: [@xy952193312-creator](https://github.com/xy952193312-creator)

Release installers (`AIStudio-CEP-Setup-*.exe`) are built from this repository by
[GitHub Actions](.github/workflows/release.yml) and signed through SignPath.io.
Until the first signed release is published, the installers are unsigned —
verify them against the SHA-256 published in each release.

## Privacy policy

This program will not transfer any information to any other networked systems
unless specifically requested by the user or the person installing or operating it.

Concretely:

- The only outbound requests are the image-generation API calls **you** configure in the
  panel's "Mine" page, sent directly to the endpoint you enter.
- No telemetry, no analytics, no hardcoded endpoints or credentials.
- Conversation history and generated images are stored locally on your machine
  (the folder is shown in "Mine → 存储位置"). Uninstalling keeps them.

## 版本记录

### v1.2.14 — 安装程序终于真的去找 Photoshop 了（2026-10-21）

用户截图反馈：机器上明明装着 PS 2025，安装向导第一页却说「没在这台机器上找到 Photoshop」。

根因不是探测写错了，是**探测函数从来没被调用**：

```
procedure DetectPhotoshop;   ← 定义在第 216 行，写得挺完整
```

全文件搜下来只有这一处 —— `InitializeWizard` 里没调它。于是 `PSCount` 恒为 0，
而界面看上去像是「扫过了，只是没扫到」。这类"写了但没接线"的 bug，
代码审查看函数体永远看不出来。

顺带修掉三个同源问题：

| 问题 | 现象 | 修法 |
|---|---|---|
| 安装器跑在 32 位模式 | `{pf}` 解析成 `Program Files (x86)`，而 PS 装在 `Program Files`，目录扫描必然落空 | `ArchitecturesInstallIn64BitMode=x64compatible` |
| `ScanFolder` 拼错路径 | `FindRec.Name` 只给最后一段（`Photoshop.exe`），拼出来是 `...\Adobe\Photoshop.exe` | 先找目录，再自己拼 `\Photoshop.exe` 验证 |
| 版本号不可读 | 注册表子键是 `190.0`（内部 build 号），用户看不懂 | 从目录名取年份，显示成 `Photoshop 2025（注册表版本 190.0）` |

第一页现在长这样（这段是安装程序自己打进日志的，不是手抄的）：

```
在这台机器上找到 1 个 Photoshop：

  · Photoshop 2025（注册表版本 190.0）
    C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe
    受支持
```

**为什么这次能被测试拦住**

`installer/test.ps1` 新增 4 项断言，其中两项专门防这个事故：

- 安装日志里必须出现「PS 探测结果：N 个」—— 函数没接线就必然不出现
- 本机注册表里有几个 PS，探测数就该 ≥ 几个

反向验证过：把 `DetectPhotoshop;` 注释掉重跑，这两项确实 FAIL（通过 23 / 失败 2）。
换句话说，这 25 项里至少有一项是**真的会咬人**的，不是摆设。

另外，探测结果和第一页正文现在都会写进安装日志，以后用户报「没找到 PS」
可以直接让他发 `/LOG` 出来的那个文件，不用再猜界面渲染成了什么。

### v1.2.13 — 查询失败不再等于任务失败（2026-10-21）

审查分支 #4。同一个任务，**判死还是不判，以前取决于它走的是哪条轮询链**：

| | 前台 `api.js` 的 `generateTask` | 后台 `tasks.js` 的 `follow` |
|---|---|---|
| 查询失败 | 记一行 warn 然后 **throw** → 整次生成判失败 | **catch 后接着问** |
| 退避 | 无 | 无（6 秒一次，能连问 150 次） |
| 判死后 | 同一会话里**没人再盯** | —（`follow` 只在面板启动时才调） |

也就是说网络抖一下，前台就 toast「生成失败」，而任务其实还在服务端跑、钱已经扣了；
要它复活，得重启面板或手动去「我的 → 任务取回」粘 ID。

**一、前台对齐后台：容忍连续 5 次查询失败**

```js
var POLL_FAIL_MAX = 5;
```

连续失败次数 `failRun` 成功一次就清零；到第 5 次才认输，抛出的 `err.taskId` 仍然带着，
页面那句「任务仍在服务端运行，别重跑」照旧生效。认输文案也写清楚了是**查询**失败，
不是任务失败——日志里也不会再出现 `失败 taskId=` 这种误报。

**二、两处轮询共用一张退避表**

新增 `U.pollBackoff(n)`：`6s → 6s → 8s → 12s → 20s → 30s` 封顶。
前台 `nap()` 和后台 `follow` 都用它，避免同一个任务「重试几次算数」取决于走哪条路。

**三、判死的同一刻交给后台接着盯**

新增 `HH.tasks.takeOver(taskId)`：`api.js` 在超时或连续失败的那一刻调用它，
`follow` 立刻接上，出图了照样自动写回那一轮对话——**不用等重启面板**。
名单里已经没有这个任务时返回 `false`（说明被手动取回过，别重复盯）。

**测试**：新增 `_test_poll.js`（29 项）。把 `window.setTimeout` 拦下来，
只把轮询那几档延迟快进成 0 并记下值，于是退避序列可以直接断言，测试也不用真等几十秒。
三条反向验证：

| 改坏什么 | 结果 |
|---|---|
| 一次查询失败就判死（回到旧行为） | 11 项失败 |
| 判死后不调 `takeOver` | 1 项失败 |
| 后台退回固定 6s 不退避 | 1 项失败（`600,6000,6000,6000`） |

全量回归 377 项全绿：composer 12 / route 11 / parse 30 / quality 53 / quality_ui 22 /
img2img 50 / gen_layout 35 / multiimg_ui 44 / mine_collapse 33 / api_log 35 / persist 23 / **poll 29**。

### 同批新增的验证工具（不改插件代码，版本号不变）

审查分支 #6。起因是发现**无头测试比真机宽松**，于是无头跑得越绿、某些坑藏得越深：

| 无头里的桩 | 真机 | 后果 |
|---|---|---|
| `evalScript` 恒返回 `EvalScript error.` | 能调 PS | 磁盘模式 / 选区读取的**成功路径从没被测过** |
| 没有 `window.cep_node` | 有（`--enable-nodejs`） | Node transport 那条路无头里不存在 |
| Chrome 120+ | Chromium 99 | 无头里写 `:has()`、CSS 嵌套不报错，**上真面板直接崩** |

- **`tools/_check_cep99.js`（11 项，纯静态、一秒跑完）**：扫 CSS/JS 里 Chromium 99 不支持的
  语法（`:has()`、CSS 嵌套、`toSorted()`、`Object.groupBy()`、连 `querySelector("div:has(p)")`
  这种同源陷阱也扫），外加 manifest 自检（**三处版本号一致**、`AutoVisible=true`、尺寸自洽）。
  反向验证：注入 `:has(` → 1 FAIL；注入 `toSorted` + `querySelector(:has)` + 改版本号 + `AutoVisible=false` → 4 FAIL。
- **`tools/_e2e_smoke.js`（真面板，只读不花钱，16 项）**：连 8701 断言面板内 `HH.VERSION` 等于源码版本、
  不是 0×0 灰屏、CSS 变量真的应用上、四个页签渲染出来、`evalScript` 能拿到 PS 版本、
  磁盘模式真的可用、diag 能记日志。**PS 没开就报 SKIP 并退出码 2——跳过必须响亮，绝不打印一排 PASS 假装跑过。**
- **真机实测（PS 2025 / CEP 12 / Chromium 99.0.4844.84，2026-10-21）**：16 项全过。
  实测确认了三件之前只能靠推断的事：① `evalScript` 真能拿到 PS 版本（`26.0.0`）；
  ② **`usable()` 为真、资料库目录已接上（`E:/PSAI`）、localStorage 里会话数为 0**——
  也就是「只要挂在 PS 里跑，一启动就是磁盘模式」，v1.2.12 里说的 8 段截断在真机上根本轮不到，
  它只活在浏览器预览这个窗口里；③ `--enable-nodejs` 生效，`window.cep_node` 确实存在。
  > 坑：8701 不是 manifest 配的，是 CEP 自己分配的（扩展目录下没有 `.debug` 文件）。
  > **面板必须被人点开过一次端口才监听**——自动起 PS 起不出端口，所以 A2 的"一键"前提是面板已展开。
- **`tools/_test_img2img_e2e_panel.js` 补完了第 2 步**：原来「出图内容确实来自参考图」在函数里
  是空的 `return null`（注释自己承认了）。现在用 12 桶色相直方图比对参考图主色有没有被继承，
  并顺带断言真机的 submit 行走的是 `/v1/images/edits`。⚠ 它会真出图、真扣费，不挂日常回归。
  **已在真面板跑通（2026-10-21，7 项全过，56.5s）**：三个主色桶 30%→27%、27%→29%、35%→33%，
  几乎 1:1 继承。这是第一次在真扣费前提下用可量化方式证明**参考图进了画面**——
  以往 `image_tokens` 线性只证明"被读走了"，这两件事本来就不是一回事。

### v1.2.12 — 持久化开始说实话（2026-10-21）

审查分支 #3。起因是一句疑问：「它不是保存在本地么？」——是，但**两种"本地"不是一回事**：

| | 磁盘文件夹 | localStorage |
|---|---|---|
| 容量 | 磁盘剩余空间 | 5MB 硬顶 |
| 用户能打开 / 备份 / 网盘同步 | ✅ | ❌ 藏在 CEP profile 里 |
| 清 PS 缓存会一起没 | 不会 | 会 |
| 图片怎么存 | 只存文件名 | 内联 base64（单条上限 16 万字符） |

所以真正的问题不是"装不下"，是**降级全程静默**。

**一、修了一个真 bug：写盘成功之前就删兜底**

`persistToDisk()` 原来是这样：

```js
try { localStorage.removeItem(K_SESS); } catch (e) {}
return Promise.all(writes);        // 写盘是异步的，还没完成
```

写盘一失败（PS 未就绪 / 目录没了 / 磁盘满），**localStorage 那份已经删了、磁盘上也不全**，
下次启动 `readIndex` 读到空，还以为"磁盘上没会话"，想从暂存迁移——也是空的。
两头空，对话全消失。而且 13 个调用点一个 `.catch` 都没有，失败变成未捕获 rejection。

现在改成：**写盘成功之后才删兜底**，失败就原样留着，至少下次还能捞回来。

**二、丢了多少段要算出来**

`LS_SESS = 8` 是"保留上限"不是"丢几段"：`list` 已按 `updatedAt` 倒序，`slice(0, 8)`
**无条件**切掉第 9 段往后——跟配额无关，装得下也照丢。而现在 `persistSessions()` /
`persistHistory()` 的返回值 14 个调用点一个都不接。

新增模块级状态 + 导出 `HH.store.persistInfo()`：

```js
{ mode: 'disk' | 'local', ok: bool, saved: n, dropped: n, at: ts, error: '' }
```

丢弃数变化时记一行 `warn`，失败记 `error`（`diag.js` 先于 `store.js` 加载，可直接用）。

**三、我的页那行说人话**

「我的 → 存储位置 → 已保存」以前写死一句 `N 段对话 · 写入文件夹 / 暂存面板内（未连接 PS）`。
现在按真实结果说话：

| 情况 | 显示 | 颜色 |
|---|---|---|
| 磁盘正常 | `12 段对话 · 写入文件夹` | 常规 |
| 暂存有丢 | `8 段已存 · 另有 4 段更早的没存下` | 警示黄 |
| 暂存失败 | `N 段已存 · 保存失败，记录还在内存里` | 红 |
| 写盘失败 | `12 段对话 · 写盘失败，记录还在内存里` | 红 |

注意有丢的时候写的是**已存 8 段**，不是内存里的 12 段——不谎报。

**测试**：新增 `tools/_test_persist.js`（23 项），覆盖 12 段丢 4 段、localStorage 实际只有 8 段、
日志留痕、界面文案与配色、以及最关键的**写盘失败时兜底那份必须还在**。

三条反向验证：

| 改坏什么 | 结果 |
|---|---|
| 把 `removeItem` 挪回写盘之前（还原旧 bug） | 1 项失败：兜底被清空 |
| `dropped` 恒置 0 | 4 项失败：不算丢、不记日志、界面不提示、不变色 |
| 写盘失败也 `return true` | 6 项失败：状态、日志、界面全线失守 |

**没做（留待评估）**：按字节自适应替代硬 8、暂存模式不内联图片。前者改动面大收益小
（真实使用中 PS 面板一启动就在磁盘模式），后者会让重启后图变灰块——那是拿"图没了"
换"对话还在"，得用户点头。

### v1.2.11 — 参考图上限跟着服务端走（2026-10-21）

v1.2.10 把上限写成 `MAX_IMAGES = 9`，是硬编码。可这个 9 是**服务端**说的
（`HTTP 400 {"code":"invalid_reference","message":"参考图最多 9 张"}`），
服务端哪天改成 5 或 12，前端就得跟着发一次版——而且用户比我们更早撞墙。

所以改成：**默认 9，一旦被服务端纠正过就以服务端为准（只降不升）**。

**一、`api.js`：从 400 文案里读懂规则**

- `parseRefLimit(msg)` 认中英两种写法：`最多 9 张` / `at most 9` / `up to 6 images` /
  `9 images at most`；抠出来的数必须落在 1–20，否则当没看见（10 张时服务端回的
  `参考图最多 9 张` 能抠到 9，`invalid_reference` 这种没数字的返回 0）
- `noteRefLimit(msg)` 记住上限，且**取更小值**——服务端只会越说越严
- `submitOnce()`：正常发；被「参考图太多」拒了，就截到前 N 张**自动重试一次**，
  并在日志里留一行 `参考图 10 张超出上限，截到前 9 张重试一次`

这条路径只在「用户选了超过服务端上限的张数」时触发一次，不会变成失败重试的循环。

**二、两个页面：`cap()` 替代写死的 9**

`generate.js` / `edit.js` 都加了：

```js
function cap() {
  var n = HH.api.refLimit();               // 0 = 还没被纠正过
  return (n > 0 && n < MAX_IMAGES) ? n : MAX_IMAGES;
}
```

替换掉上传框文案、`pickSelection` 的 `max`/`maxMsg`、`uploader.bind` 的 `addImages` 截断、
历史回填的 `slice(0, …)`。

`uploader.bind` 那里特意用了 **getter**：`get max() { return cap(); }`。
`bind()` 只在页面初始化时跑一次，写成 `max: MAX_IMAGES` 的话，
之后学到的上限永远传不进去（这条有专门的反向验证，见下）。

**三、不偷偷丢图**

上限被压小之前，用户可能已经选满了旧上限那么多张。提交前 `clampImages()` 先夹到新上限，
并弹一句 `服务端当前最多 5 张，已只保留前 5 张`——而不是让 api 层悄悄截掉几张，
让用户只看到「少了几张图」却不知道为什么。

结果卡片副标题也跟着用 `Math.min(images.length, cap())`，重试只发了 9 张就写「9 张输入」。

**测试**：`_test_api_log.js` 23 → 35 项（新增 6 项解析用例 + 6 项截断重试用例），
`_test_multiimg_ui.js` 43 → 44 项（新增「学到 5 张后文案变 5」「提交前 7 张夹到 5 张」
「读取选区按新上限收」）。

三条反向验证（改坏 → 应挂 → 还原）：

| 改坏什么 | 结果 |
|---|---|
| 去掉 `submitOnce` 里的重试分支（`if (false)`） | 1 项失败：400 直接抛给用户 |
| `uploader.bind` 的 `get max()` 改回 `max: MAX_IMAGES` | 1 项失败：`max=9`（学到的 5 传不进去） |
| 去掉 `run()` 里的 `clampImages()` 调用 | 1 项失败：`7 -> 7`（夹取没发生） |

### v1.2.10 — 上限改成 9、请求进日志、结果卡片副标题、Key 可一键清除（2026-10-20）

这一版源自一次逐条掰分支的设计审查（审查仍在进行）。四条改动：

**一、上限 10 → 9（实测打脸，原来那个 10 是拍脑袋的）**

`node tools/_test_multiimg.js wide` 跑 3 / 6 / 10 张递增对照：

| 张数 | image_tokens | 画面里的颜色种类 | 结果 |
|---|---|---|---|
| 3 | 1245 | 4 | ✅ |
| 6 | 2490 | 7 | ✅ 第 4~6 张确实进了画面 |
| 10 | — | — | ❌ HTTP 400 `参考图最多 9 张` |

补跑 9 张确认：HTTP 200，`image_tokens=3735`，12 格色相直方图里 10 格 ≥3%——**9 种输入色全部出现在结果里**。

所以：多图是真功能（不是只有第一张生效），但第 10 张不是被静默忽略，是**整单失败**。
`MAX_IMAGES` 改 9（两页一致）。详见 `_img2img_test/FINDINGS.md`。

**二、A3：API 请求终于进诊断日志了**

之前 `api.js` 一行 diag 都没写过——出图失败后翻日志，看不到走了哪个端点、传了几张、耗时多少。
现在按三条粒度记：

- 提交必记：`submit mode=edit 图片 3 张 url=https://…/v1/images/edits`
- 轮询**只在状态跃变时**记：稳态 6 秒一次，15 分钟能刷 150 行，全记会淹没关键那几行
- 终态必记带耗时；超时/失败把 **taskId 留在日志里**（它是断点续取的凭据）

红线不变：不记 apiKey、不记 header/body，`safeUrl()` 连 query 都会砍掉。

**三、结果卡片副标题**

模式是隐式的（有图走 `edits`、无图走 `generations`），界面没有开关，所以卡片上留一处痕迹：
传了图 → `3 张输入`；一张没传 → `文生图`；老记录没有这个字段就**不显示**（不知道的事不编）。

**四、API Key 可一键清除**

Key 是明文落在 localStorage 的。CEP 没有安全的密钥存储可用，加密/混淆只是安全剧场
（同源脚本一读就解，还容易让人误以为安全）。所以给的是诚实手段：Key 输入框旁边一个「清除」，
一键抹掉盘上那份。**只清 Key**，服务地址 / 模型 / 历史 / 对话全保留。
文案也从「仅存本机」改成实话「明文存本机，用完可清除」。

**测试**：新增 `_test_api_log.js`（23 项，把 `window.fetch` 换成按脚本出牌的假实现；
v1.2.11 扩到 35 项）。`_test_multiimg_ui.js` 41 项（v1.2.11 扩到 44 项）、
`_test_gen_layout_ui.js` 35 项、`_test_mine_collapse.js` 33 项。
关键项都做了反向验证：去掉跃变守卫 → 2 FAIL；只清内存不落盘 → 1 FAIL。

---

### v1.2.9 — 多图（上限 10 张）+ 拖动排序 + 我的页可折叠（2026-10-20）

**一、先实测：多图到底认几张**

「上限 3 张」是拍脑袋定的，放开之前先问服务端。参考图统一 512×512 纯色底 + 中心白圆，
提示词一律用「改成水彩风格的抽象画」——**不写"风景画"**，因为风景天然偏绿会污染主色判定
（第一版就踩了这个坑，74% 绿其实是"水彩风景都偏绿"，不是"只读了绿图"）。

| 输入 | `image_tokens` | 输出主色 |
|---|---|---|
| 1 张 | 415 | 纯色 |
| 2 张 | 830（2.00×） | **左绿右橙并排双色块** |
| 3 张 | 1245（3.00×） | 三张都被读进去 |
| 红+黄+蓝 | — | **三色全部出现在同一张输出里** |

计费严格线性 → 服务端**每一张都读了**；红黄蓝那组三色齐全 → 确实**会融合**。

**一个反直觉的坑**：`[绿,橙]` 融合了、`[橙,绿]` 却只出橙，乍看像"只认第一张"。
实际是**模型的语义选择** —— 绿橙同属暖色能合成双色块，而把暖橙改成冷绿，
模型认为违背意图就只留了橙。所以判定多图是否生效，必须用**色相分离度大的组合**，
用相近色 + 顺序对照会得出完全相反的结论。

**结论**：上限从 3 放开到 **10**。服务端不拒绝、不漏计费。融合靠模型语义，
不保证每张都体现（这是模型行为，不是接口契约）——**界面不加任何提示文案**，
结论只写在 `FINDINGS.md` 和 `api.js` 注释里。

**二、第一张 = 底图（顺序有主次，不是普通数组）**

实测支撑：`[绿,橙]` 输出是**左绿右橙**（第一张占主位）；`[橙,绿]` 语义冲突时保留的是**第一张橙**。
所以 `images[0]` 是底图/主图，后续是参考图。两条硬要求：

1. UI 顺序**原样**传给 `buildEditsForm`，中间不排序、不去重、不过滤；
2. 拖动排序是真功能 —— 用户靠拖动决定"哪张当底图"，所以角标显示「底图 / 参考2 / 参考3」，
   换位后**立刻重算**（拖动过程中就要对，不能等松手）。

**三、缩略图挪进上传框**

原来框是空的、缩略图挂在框下面，看着像两块不相干的区域。现在缩略图就在高亮框**里面**，
有图时图标和引导文案整块撤掉，框里只剩缩略图，不再堆字。框的高度也从 92px 提到 120px。

顺带修了点击冲突：缩略图进了框之后，点缩略图（本意是看大图）会冒泡到上传区、
把文件选择框也弹出来。现在点 `.thumb-strip` 一律不触发上传。

**四、拖动排序用指针事件，不用原生 HTML5 拖放**

原因有两个：CEP 里原生 drag 事件会被宿主吞掉；缩略图就在上传区里，
原生 drag 会和"拖文件进来上传"抢同一片区域。指针事件自己算位移（5px 阈值），
两种意图能彻底分开。

**五、负向提示词挪到提示词下面**

原来它躲在「生成设置 → 高级设置」折叠里，隔着两层，写提示词的人根本想不起还有这一栏。
现在直接挂在提示词输入框下方常驻展开，「高级设置」折叠整个删掉。

**六、我的页七个区块可折叠，状态记住**

默认只展开「API 服务配置」——没配 API 之前那是唯一必须填的；其余六块默认收起，
全展开会把这页拉得比面板还长。折叠状态存进 `state.ui.mineOpen` 并落盘。

> 折叠**只能靠 CSS 收起**，不能改成"展开了才渲染"。这一页的输入框是 `bind()` 里一次性
> `wire()` 绑定的，收起时删掉 DOM 就等于删掉绑定 —— 表现是"折叠过的区块，改了配置保存不进去"，
> 而且只在折叠过之后才复现。测试里专门守了这条。

**七、修了个真 bug：`#cfgTest` 重复 id**

「测试连接」按钮和结果显示容器都叫 `cfgTest`。`U.$('#cfgTest')` 只拿得到按钮，
于是测试结果被写进了按钮里，把「测试连接」四个字冲掉，按钮变成一坨 HTTP 状态码。
结果容器改名 `#cfgTestResult`。

**回归**：新增 `tools/_test_multiimg_ui.js`（28 项）、`tools/_test_mine_collapse.js`（26 项）；
`_test_gen_layout_ui.js` 扩到 32 项。全量 250+ 项，0 失败。

关键测试都做了**反向验证**（故意改坏实现，确认测试真的会红）：
去掉点击冲突守卫 → 2 项失败；去掉角标重算 → 拖动过程中报 `参考3 / 底图 / 参考2`；
把 `#cfgTestResult` 改回重复 id → 3 项失败。

> 改 `js/uploader.js`、`js/pages/generate.js`、`js/pages/edit.js`、`js/pages/mine.js`、
> `js/store.js`、`js/api.js`、`css/app.css`、`js/util.js`、`CSXS/manifest.xml`。
> 新增 `tools/_test_multiimg.js`（多图实测）、`tools/_shot_ui.js`（静态截图）、`tools/_stub_cep.html`。
> **需要重启 Photoshop**。

### v1.2.8 — AI 生图改成双模式：文生图 / 图生图（2026-10-20）

这一版做的是「AI 生图页支持图生图」。中间差点做错，记一下过程。

**先做的实测（四轮对照实验）**

改页面之前先验证 `/v1/images/generations` 到底认不认 `image` 字段 —— 因为 `quality` 已经坑过一次：
字段能发、服务端 200、任务照跑，但根本不生效。结果：

| 轮次 | 方法 | 结果 |
|---|---|---|
| 1 | 白猫提示词 + 红蓝图 | 两组都出白猫，图里颜色零出现 |
| 2 | 提示词自己说了颜色 | 作废 —— 纯文生图也能画出来，测不出差别 |
| 3 | 提示词不提颜色，只给极简海报 | 两组构图几乎一样，都跟参考图无关 |
| 4 | **发纯灰噪点图**，提示词写「色彩鲜明」 | 产出依旧干净鲜艳，噪点毫无影响 |

**结论：`generations` 会静默丢弃 `image`。** 如果按原计划直接把 image 接上去，
这就是个和 quality 一样的空转功能 —— 用户以为图生图，实际还是文生图，服务端连报错都不给。

**转折：`/v1/images/edits` 是通的**

OpenAI 官方本来就把图生图放在另一个端点。拿同一张红蓝图试：

- 无鉴权 → `401 Token not provided`（端点存在）
- 带图 multipart → `200`，且 `usage.image_tokens = 415`（图真被读了、真计费了）
- 提示词「改成水彩风景」→ 出图是**红天、蓝海、正中黄色落日**，完整继承了参考图的三段式布局
- 面板内 `fetch + FormData` 也通，且支持 `async: true`，返回同形 task id
- 轮询走 `GET /v1/images/generations/{id}` 照样能查到 —— 不用为 edits 另写一套

**架构：有图走 edits，无图走 generations**

```
无图  ->  POST /v1/images/generations   (JSON)
有图  ->  POST /v1/images/edits         (multipart/form-data)
```

统一收在 `api.js` 的 `submitGenRequest()` 里。抽出来的原因是两条调用链（同步 `generate` /
异步 `createTask`）都要判一次，重复两遍迟早不一致 —— 一处改了另一处忘，就会出现
「预览能出图、生成不出图」这种最难查的问题。

两个容易踩的点已写进注释：

- **绝不能手写 `Content-Type`**。multipart 的 boundary 由浏览器生成，自己写死一个
  而 body 里没有对应分隔符，服务端要么解析失败要么静默忽略。
- **`protocol: 'custom'` 保持原样**。自定义协议的服务商有自己的 JSON 格式，
  不能被劫持到 edits。

**页面改造：不设模式开关**

模式由**有没有图**推出来，界面上只有一个真相：

- 无图 = 文生图，按钮显示「生成」
- 有图 = 图生图，按钮显示「生成（图生图）」，页头提示「按图生图处理」
- 删掉最后一张图 → 自动回到文生图

不做开关是因为开关会和图的状态打架：用户删完图、开关还停在「图生图」，
生成时就只能报错或者偷偷降级，两种都不好解释。

**布局调整**（顺序按用户确认的方案）：

```
图片（最上面，它就是模式开关）
  └ 上传框：拖入/点击上传，缩略图就在框里
    读取选区 · 上传本地 · 清空
提示词（含负向提示词）
生成设置（模型 / 比例 / 张数 / 质量）
```

原来「参考图」在最底下，现在挪到顶部并改名为「图片」。所有跟模式有关的文案
（标题提示、上传区文案、提示词占位符、按钮文字）都在 `syncMode()` 里统一刷新，
不整页 remount —— 否则图片预览、输入焦点、滚动位置全丢。

**两边统一**：`读取选区` 的逻辑抽成 `HH.uploader.pickSelection()`，
智能改图页和 AI 生图页共用同一份。之前各写一遍，上限提示、失败文案、按钮恢复
迟早会岔开，用户切页就会觉得「时好时坏」。

**其它小改动**

- 缩略图第一张的角标叫「底图」—— 在 `/images/edits` 里它是被改造的对象，不是参考资料
  （v1.2.8 时单图不标角标；v1.2.9 起单图也标，因为「底图」是拖动排序唯一的说明书）
- 图片上限从 2 提到 3，与智能改图页一致
- `state.generate` 正式加上 `images` 字段（原来只在 `bind()` 里临时补）

**测试**

- 新增 `tools/_test_img2img.js`（50 项）：双端点分流。核心断言是
  「无图 → 请求体里绝不能有 `image`」「有图 → 必须走 edits 且 body 是 FormData」
- 新增 `tools/_test_gen_layout_ui.js`（26 项）：真实页面里的区块顺序、模式文案、
  清空回退、不能出现模式开关、最窄面板不横向溢出
- 新增 `tools/_test_img2img_e2e_panel.js`：在运行中的面板里真跑一次完整图生图
  （提交 → 轮询 → 取图），这是唯一能发现「CEP 环境特有 bug」的测试
- **对照实验**：把 `submitGenRequest` 的双端点判断强制改成 false（永远走 generations），
  测试精确报出 6 项失败，且全部指向「URL 不对 / body 不是 FormData / 手写了 Content-Type」
- 全量回归 241 项，0 失败

**端到端测试挖出的真实 bug（值得单独记）**

面板里第一次跑图生图直接失败：

```
网络请求失败：The "chunk" argument must be of type string or an instance of Buffer
or Uint8Array. Received an instance of FormData
```

根因是 `nodeRequest()` 只判 `nodeRequire()` 而不判 `NODE_TRANSPORT` 开关。CEP 里
`window.cep_node` 是存在的（Node 能力可用），但开关一直是 `false`（当年开着会让 PS 崩，
见函数上方注释）。于是本该走 fetch 的请求被塞进 Node 的 `http.request`，
FormData 被 `String()` 成 `"[object FormData]"`。

修法两道保险：
1. `nodeRequest` 开头先判 `NODE_TRANSPORT`，关着就直接返回 null；
2. 即使开关将来打开，遇到 `FormData` 也返回 null —— multipart 的 boundary
   只有浏览器知道，Node 通道不可能正确发送。

**这个 bug 单元测试抓不到**，因为单元测试里 `NODE_TRANSPORT` 是 false、
`cep_node` 也没挂，路径根本走不到。只有放进真面板才暴露。教训：涉及运行时能力探测的
分支，必须在目标运行时里验一次。

实测报告见 `_img2img_test/FINDINGS.md`。

### v1.2.7 — 实测修正：失败响应被当成图片（2026-10-20）

v1.2.6 交付后拿真 key 打了一轮中转站，挖出两个问题。

**1. 失败任务被当成成功，图的内容是错误文案（真 bug）**

某中转服务返回的任务失败长这样：

```json
{
  "status": "failed",
  "data": [{ "url": "非常抱歉，生成的图片可能违反了关于裸露、色情或情色内容的防护限制。…" }],
  "error": { "message": "您的提示词或参考素材未通过内容审查，请修改后重新提交。" }
}
```

注意 `data[0].url` 里放的是**中文错误文案，不是 URL**。原来的 `parseResponse` 看到 `it.url` 有值就当图片收下，于是：

- 失败任务被判定为成功；
- 面板拿一段中文当图片地址，结果显示成一张破图；
- 真正的失败原因（`error.message`）反而被丢掉，用户完全不知道发生了什么。

修法：新增 `looksLikeImage()`，只认 `http(s)://` 或 `data:image/` 开头。
不像图片的一律丢弃，改由新增的 `errorTextOf()` 从 `error.message` / 顶层 `message` /
`data[0].url` 三处兜出可读原因，直接呈现给用户。

同时补了两个相邻的洞：

- `pollTask` 遇到 `completed` 但一张有效图都解析不出来时，之前会静默返回空数组
  （上层只显示「共 0 张」），现在按失败处理并带上原因；
- `generateTask` 里 `urlToDataUrl(u).catch(() => u)` 这个兜底会把非图片地址塞进 `<img>`，
  改成只退「看起来像图片」的。

**2. `quality` 在这个中转站上是空转**

v1.2.6 假设「发错档位会 400」，实测**不成立**：

| 发出去的 | 结果 |
|---|---|
| `gpt-image-2` + `quality: "THIS_IS_INVALID"` | HTTP 200，照常起任务 |
| `gpt-image-2` + `xhigh`（该模型不支持） | HTTP 200，照常起任务 |

也就是说中转站**完全不校验这个字段**，传什么都被静默接受。
那它到底生效吗？同一提示词、同一模型，只改档位，各跑一张：

| 模型 / 档位 | 尺寸 | 文件大小 |
|---|---|---|
| `gpt-image-2` / low | 1254×1254 | 2082 KB |
| `gpt-image-2` / high | 1254×1254 | 1847 KB |
| `gpt-image-2` / xhigh | 1254×1254 | 2367 KB |

尺寸完全一致，大小差异在正常随机波动范围内（内容不同，体积本来就会浮动），
**没有出现档位该有的数量级差异**。目视对比锐度也没有档次差异（`low` 那张甚至更锐，
因为背景更简单）。对照图见 `screenshots/quality-cmp-{low,high,xhigh}.png`。

**结论：字段按标准传，能不能生效取决于上游是否透传。** 界面上保留这一项（换别家可能就生效），
但不承诺效果。

**顺带修正档位表**

v1.2.6 按 `-sunburst` / `-flare` 后缀判断 2.5，漏了中转站实际存在的这几个名字：

`gpt-image-2.5`（无后缀）、`gpt-image-2.5-x`、`gpt-image-2-x`、以及 `-1k/-2k/-4k` 各种组合。

改成按前缀 `^gpt-image-2\.5(\b|[-.])` 判断后，`gpt-image-2.5` 系列全部拿到六档
（`gpt-image-2.5` 无后缀以前会被误判成四档，选不到 `xhigh` / `max`）。

> 改 `js/api.js`、`js/util.js`、`CSXS/manifest.xml`。
> 新增 `tools/_test_parse.js`（30 项，用例全部取自本次实测响应）。
> `tools/_test_quality.js` 扩到 53 项，补入实测模型名。
> **需要重启 Photoshop**。

### v1.2.6 — 生图质量档位（quality）（2026-10-20）

`gpt-image` 系列除了比例，还有一个 `quality`（画质）参数。之前面板没做，只能吃服务端默认值。

**难点不在加个下拉，而在「合法值是跟模型走的」**

| 模型 | 可用档位 |
|---|---|
| `gpt-image-1` / `-mini` / `-1.5` / `-2` | `auto` `low` `medium` `high` |
| `gpt-image-2.5-sunburst` / `-flare`（含快照、含 `-1k/-2k/-4k` 后缀） | 上述 + `xhigh` `max` |
| `midjourney` / `grok-imagine` / `gemini-*` 等 | 不认这个字段 |

所以不能写死一个 `low/medium/high` 下拉：

- 给 `gpt-image-1` 发 `xhigh` → 服务端 400；
- 给 `2.5-sunburst` 只留到 `high` → 白瞎它最贵的两档。

**做法：一张能力表 + 两处收敛**

`api.js` 里新增 `qualityOptions(model)`，由模型名推导档位；非 `gpt-image` 系列返回 `null`，
页面这时**整行都不渲染**——显示一个「选了也发不出去」的空下拉比不显示更糟。

`normalizeQuality(model, quality)` 负责把用户存的值收敛到合法范围。
换模型时如果旧值失效（比如挂着 `xhigh` 切回 `gpt-image-1`），自动回落到 `auto`，不报错、不静默发非法值。

**落位**

- **AI 生图页**：参数区单独一行「质量」（不是塞进 `.grid-2`——三个 select 挤进两列，
  面板拉到最小 330px 时每格只剩 ~95px）。默认 `auto`，不是 `medium`。
- **智能改图页**：并进参数条，56px 窄一档，给模型名留宽度。
- **`custom` 协议**也带上了（`buildCustomPayload`），方便自己改名。

**几个刻意的取舍**

- `-1k/-2k/-4k` 是**模型名的一部分**，不是 quality 也不是 size。
  `gpt-image-2-4k` 仍然是四档——分辨率靠 `size`，不靠 `quality`。
- 默认 `auto` 而非 `medium`：多数服务商把 `medium` 当默认，但 `auto` 是官方默认、
  会按模型自动挑档。用户第一次打开面板，不该被一个凭空出现的选择改变出图结果。
- `response_format` 保持 `b64_json` 不动。`gpt-image` 系列本来就不支持 `url`。
- 本轮**不做** strength / 重绘幅度。

> 改 `js/api.js`、`js/store.js`、`js/pages/generate.js`、`js/pages/edit.js`、`css/app.css`、`css/theme.css`、`js/util.js`、`CSXS/manifest.xml`。
> 新增 `tools/_test_quality.js`（38 项）。
> **需要重启 Photoshop**。

### v1.2.5 — 输入区可拖动 + 提示词上限 2000（2026-10-20）

两个使用体感问题，一起解决。

**1. 提示词框太矮，看不下长句**

原来 CSS 写死 `max-height: 96px; resize: none`。`resize: none` 是刻意关的——
CEF 原生拖柄是右下角一个小三角，面板才 380px 宽，几乎点不中。

改法是自己做一个拖动条：输入区顶部一条 10px 高的横杠，`cursor: ns-resize`，
向上拖变高、向下拖变矮。

- 用 **pointer 事件**而不是 mouse：触摸屏 / 数位屏上 mouse 事件根本不派发；
- `touch-action: none`，触屏上别让浏览器抢去做滚动；
- 拖动期间给 `body` 加 `is-resizing`（禁选中 + 改光标），否则一边拖一边刷蓝一片文字；
- 上下限：`56px`（两行自然高度）到「面板高度 × 70% − 80px」，随面板尺寸动态算，
  面板拉高后输入框也能更高；
- 高度存进 `localStorage`（`aistudio.ui.v1` 的 `composerH`），切页、重开都保持；
- **双击拖动条复位**，调乱了能一键回到默认。

下限取 56 而不是 54 是有原因的：textarea 两行的自然高度就是 56
（padding 8×2 + border 1×2 + 行高 19×2，`box-sizing` 是 `border-box`）。
对齐它，双击复位前后才不会有 2px 的跳动——测试里这条当初就是 FAIL 揪出来的。

**2. 字数上限 500 太紧，且两页不一致**

「智能改图」写 500、「AI 生图」写 800，各写各的，于是出现「这页打得下、那页打不下」。

统一提到 `util.js` 的 `HH.MAX_PROMPT = 2000`，两页都读它。
这个值纯粹是界面限制、不参与任何校验；真正的约束来自你填的 API，
一般模型都能吃几千字符，超了服务端会自己报错，届时按提示再调。

**测试**

新增 `tools/_test_composer.js`——**端到端**，不是假 DOM。用无头 Chrome 打开真实
`index.html`，真的派发 `pointerdown / pointermove / pointerup`，
再读 `offsetHeight` 和 `localStorage` 断言。12 项覆盖：
拖动条存在、初始 56、上限约束（不把消息区吃光）、下限 56、高度入库、双击复位。

也做了对照：拿 v1.2.4 的代码跑同一套，`拖动条存在` 直接 FAIL，说明测试咬得住。

> 改了 `js/util.js`、`js/store.js`、`js/pages/edit.js`、`js/pages/generate.js`、`css/app.css`。
> **需要重启 Photoshop**。

### v1.2.4 — 环境区自动刷新（2026-10-20）

「诊断与日志」里的环境快照，之前只在页面挂载那一刻画一次。而
「写入方式」「日志目录」「AutoVisible」这几个字段都要等异步操作完成才有值，
于是永远停在「尚未写入 / 解析中…」，得手动点一下「刷新」才对。

**改法**

- `diag.js` 新增 `onFlush(cb)`：刷盘成功后通知订阅者，返回注销函数；
  回调逐个 try-catch，页面重绘炸了也绝不能反过来影响刷盘；
- `mine.js` 新增 `watchDiagFlush()`：订阅刷盘，300ms 节流后重绘环境区。

两个保护值得记一笔：

1. **节流** —— 刷盘可能每几秒一次，不必每次都重建 DOM；
2. **自清理** —— 切页是**换节点**（`freshView()` 直接 `replaceChild`），
   没有 unbind 钩子，所以订阅会一直挂着。这里在回调里判断 `#diagEnv`
   是否还在文档中，不在就自我注销，避免闭包在 `diag.js` 里越积越多。

顺带把日志列表的滚动位置保住了——自动刷新每几秒来一次，不保位置的话
你正看到第 30 行会被弹回顶部。

**测试**：`tools/_test_diag.js` 新增 4 项（回调返回注销函数、刷盘通知、
注销后不再收到、**回调抛异常不影响刷盘**），共 37 项全过；路由测试 11 项全过。

> 改了 `js/diag.js`、`js/pages/mine.js`。**需要重启 Photoshop**。

### v1.2.3 — 日志改为真追加，杜绝覆盖（2026-10-20）

v1.2.1 修了「`stat` 取不到 size 导致覆盖」，但那只是把触发条件换了个位置，
根子上的危险推断还在：**读文件读到空，就当成「文件不存在」，然后写 header + 新增**。

而 `readText()` 分不清两件事——「文件确实不存在」和「读取失败了」，
两者都返回空串。CEP 12 上写完立刻读拿不到内容就会走到后者，
后果是**已经落盘的取证记录被一次寻常刷盘整段抹掉**。

**改法：不再读旧内容**

manifest 开着 `--enable-nodejs`，于是主路径换成 Node 的 `fs.appendFileSync`——
内核级追加，压根不需要读回旧内容，**覆盖这个动作在物理上就不存在了**。

- 主路径 `appendViaNode()`：`statSync` 判存在（`Node` 的 stat 可靠，不像 CEP 的），
  不存在就建文件写 header，存在就直接追加，超 512KB 才重写；
- 降级路径 `appendViaCep()`：Node 不可用时退回原来的读回拼接，**但加了一道保险**——
  本次会话已经写过这个文件却读不到内容，只可能是读取失败，
  于是**跳过这次刷盘、等下一轮重试**，绝不覆盖。最多晚一点落盘，不会毁掉已有记录；
- `headerDay` 标记按天记录 header 写过没有，跨天自动失效，`clear()` 时重置；
- `env()` 新增「写入方式」一行，显示 `node-append` 或 `cep-fs`，
  部署后一眼能看出主路径有没有真正生效。

**回归测试（做了新旧对照）**

`tools/_test_diag.js` 把 Node 的 `fs` 也接到同一份 memFs 上，这样两条路径共用存储、
都能断言，并加了三个故障开关（`readFail` / `nodeBroken` / `appendFail`）。

拿 v1.2.2 的 `diag.js` 跑同一套测试，**6 项失败**，其中最有说服力的一条：

```
FAIL  读取失败时不覆盖已有内容  → 1768 → 250
```

**1768 字节的文件被抹成 250 字节** —— 这就是那个 bug 的实锤复现。新版 32 项全过。

> 只改了 `extension/js/diag.js` 一个文件，另加版本号。**需要重启 Photoshop**。
> 重启后到「我的 → 诊断与日志」看「写入方式」，应为 `node-append`。

### v1.2.2 — 启动重复挂载修复（2026-10-20）

日志能落盘之后，第一份实机日志就暴露了一个问题：

```
[15:14:04.282] INFO mount | 挂载页面 edit
[15:14:04.292] INFO mount | 挂载页面 edit   ← 10 毫秒后，同一页又挂了一遍
```

**两个根因**

1. **启动重复挂载**：`init()` 自己 `mount()` 了一次，而它前面赋 `location.hash = '#/edit'`
   会**异步**派发一次 `hashchange`，那个监听器又 `mount()` 一次。于是冷启动固定挂两次。
   以前一直存在，只是没有日志看不出来。
2. **点当前 Tab 会重挂**：`go(route)` 里判断「hash 没变」时直接调 `mount()`，
   本意是刷新，实际是整页销毁重建——连点五下同一 Tab 就重挂五次，
   副作用是滚动位置回顶、正在输入的焦点丢失。

**改法**

- 启动阶段加 `booting` 标记，`init` 挂完后 50ms 内来的一次 `hashchange` 直接吞掉
  （只吞一次）。给 50ms 是因为 CEP 里 hashchange 派发偶尔拖到十几毫秒。
- `go()` 点当前 Tab 直接 `return`，什么都不做。
- 新增 `remount()`：路由不变、只是数据变了（保存配置 / 删历史 / 清日志）时用它，
  不碰 hash、不重新算路由、日志单独记成 `remount`。`refresh()` 保留为它的别名，
  `pages/*.js` 和 `store.js` 里十几处调用一行没改。
- `mount(why)` 现在带原因参数，日志变成 `挂载页面 edit · boot` / `· 切页` / `· guard`，
  一眼能分出是启动、切页还是守卫补挂。
- 顺手加了滚动位置记忆：切走再切回来，滚动条还在原处。

**回归测试**

新增 `tools/_test_route.js`，在 Node 里搭迷你 DOM + hash 环境把 `app.js` 原样跑起来，
数 `bind()` 被调用几次，覆盖 7 个场景 11 项断言。

关键是**做了对照**：拿 v1.2.1 的 `app.js` 跑同一套测试，**7 项失败**，其中
`冷启动只挂载一次 → 实际 edit,edit` 正是实机日志里那两条。换成新版全部通过——
说明测试确实咬得住这个 bug，不是写完就算。

> 改了 `js/app.js`、`js/guard.js`、`js/util.js`（版本号）、`CSXS/manifest.xml`，**需要重启 Photoshop**。

### v1.2.1 — 日志落盘修复（2026-10-20）

v1.2.0 上了日志之后，本机实测发现：**日志文件里永远只剩最后 3 条**，开机那一行也没了。查下来是刷盘逻辑的坑。

**根因**

`doFlush()` 用 `cep.fs.stat` 判断当天日志文件是否已经存在，存在就追加、不存在就写「环境头 + 本次新增」。
问题是 CEP 12 的 `stat` 经常**取不到 size**，于是每次都被判定成「文件不存在」，
直接走 `header + add` 分支 → 上一次刷进去的内容被整段覆盖。

表现很有迷惑性：文件确实在、确实在增长/变化，只是里面始终只有最近一次 flush 的几条，
所以在面板里看列表是正常的（内存缓冲有 300 条），不打开文件根本发现不了。

**改法**

不再信 `stat`，改成**真的把旧内容读回来**：

```js
var old = readText(path);
if (old.length + add.length > MAX_BYTES) { /* 超限重写，丢弃更早记录 */ }
var text = old ? old + add : header() + '\n' + add;
```

读回来是空串才当作文件不存在。顺手删掉了已经没用的 `fileSize()`。

**回归测试**

`tools/_test_diag.js` 里把 `window.cep.fs.stat` 特意 mock 成**取不到 size**（复现真实 CEP 12 行为），
加了两条断言：多轮刷盘后最早那条锚点记录仍在、环境头没有重复出现。24 项全过。

> 只改了 `extension/js/diag.js` 一个文件，不需要改 manifest/jsx，**但还是要重启 Photoshop** 才会加载新脚本。

### v1.2.0 — 内置诊断日志（2026-10-20）

「我的」页新增「诊断与日志」分区，用来替代此前那个临时的绿色测试面板（`com.xy.probe`，已删除）。

**为什么**

排查灰屏最难受的是没有任何反馈：页面活着但画不出来，JS 日志也看不到。
独立测试面板只能回答一个是非题，还占目录和菜单；收进插件后既能实时看，
又能**落盘取证**——灰屏时面板打不开，只有磁盘上的日志能事后查看。

**内容**

- 环境快照：插件版本、Chromium 版本（附 CEP 对照）、Photoshop 版本、面板尺寸、
  出帧率、可见性、**manifest 里 `AutoVisible` 的实际值**、日志目录、缓存目录、Local Storage 占用；
- 日志列表：按级别配色，最新的在最上面；
- 按钮：刷新 / 复制 / 打开目录 / 清空。

`AutoVisible` 那一项是专门加的——它是灰屏的头号嫌疑，下次再看一眼这个值就不用重新排查。

**落盘规则**

- 位置：`<userData>/AIStudio/logs/panel-YYYYMMDD.log`，按天分割，单文件 512KB 封顶；
- 时机：累积 20 条、或间隔 10 秒；**error 立即刷**（这类记录最值钱）；
- 方式是追加而非覆盖——否则面板收起重建后内存一空，当天日志就被抹掉了；
- 日志**不记 apiKey**，只记 URL 与状态，复制导出都不会泄密。

> 注意：改了 `jsx/host.jsx`（新增 `__aiLogDir()`）与 `CSXS/manifest.xml`，**需要重启 Photoshop**。

### v1.1.1 — 灰屏修复 + 版本支持声明（2026-10-20）

修掉了一个致命问题：面板一片灰、只有标题栏。

**根因**

`CSXS/manifest.xml` 里的 `AutoVisible` 设成了 `false`。在 PS 26 / CEP 12 上，这会让面板
「加载成功但拿不到可见区域」——JS 正常跑、DOM 完整、rAF 60fps、通过 CDP 能截到完整画面，
屏幕上却是一片灰。已改回 `true`。

排查时被带偏过几次，以下**都不是**原因，记录在此免得重蹈覆辙：

- GPU / Vulkan 驱动冲突（`RayLink Virtual Display Adapter` 与 NVIDIA 争抢）—— 加 `--use-angle=gl` 后 GPU 报错全部消失，面板照样灰；
- 扩展没签名 —— `CSXS.9` ~ `CSXS.20` 的 `PlayerDebugMode` 全为 1，未签名扩展照常加载；
- `SetParent() failed`、`parent=0`、`vis=false` —— 正常显示的面板（含 DLSS 5）测出来也是同样的值；
- 窗口层级 / Z 序、CEP 绘制缓存。

**顺带解决的问题**

- 当初把 `AutoVisible` 设成 `false` 是为了规避输入法挂接，实测 **CEP 12 上中文输入本来就正常**，该顾虑不成立；
- 不想「开 PS 就自动弹面板」，正解是收起面板让 PS 记住工作区（`Essentials.psw`），
  而不是改 `AutoVisible`。`window.cep` 只有 `fs / process / encoding / util`，没有关闭面板的接口，页面无法自行收起。

**版本支持**

`Host Version` 明确为 `[23.0,99.9]`，即 **Photoshop 2022 及以上**。下限由 CSS 决定：
`flex gap` 需 Chromium 84+、`inset` 需 Chromium 87+，二者都到 CEP 11（PS 2022）才支持；
JS 与 JSX 侧本可下探到 CC 2019。

> 装过旧版的注意：改了 `CSXS/manifest.xml`，**需要重启 Photoshop** 生效。

### v1.1.0 — 首个正式版（2026-10-20）

异步出图全链路跑通并实测，可以日常使用了。

**出图**
- 提交即返回任务号（约 0.5 秒），改为按 `task_id` 轮询，不再是一个几十秒的长请求；
- **中途收起面板不再丢图**：任务号同步写进 localStorage，展开后自动续取、写回原来那一轮对话并落盘；
- 「我的 → 任务取回」可按任务 ID 手动取回，也能打开图片文件夹。

**数据可靠性**
- 参考图在提交时即刻落盘（`images/img_*.jpg`），会话只记文件名 —— 面板收起会重建页面（等同整页重载），但对话、参考图、结果图都能原样恢复；
- 当前会话为空壳时自动读回消息体，重载后不再是一段空对话；
- 消息保留 `taskId` / `taskStatus`，重载后「取回结果」按钮不会消失。

**界面**
- 「我的」页移除免责提示块，底部改为单行 `版本 · ● Photoshop 连接状态`；
- 版本号收敛到 `HH.VERSION` 一个来源，与 `CSXS/manifest.xml` 保持一致；
- 清理全量死样式与未引用图标（CSS 类 184 → 181）。

**稳定性**
- 新增 `js/guard.js`（最先加载）：全局异常红条提示 + 看门狗，Tab 没渲染出来会自愈重挂载；
- 新增 `kickRepaint`：面板重新可见时强制重绘，避免「DOM 还在但一片灰」。

> 装过旧版的注意：本次改过 `CSXS/manifest.xml`，**需要重启 Photoshop** 让新清单和版本号生效。
> 面板若整体发灰，先清 `%TEMP%\cep_cache\PHXS_*\com.xy.aistudio.cep.panel\` 下的
> `Cache / Code Cache / GPUCache / Session Storage`（**保留 Local Storage**，里面是配置和待取回任务）。

## 快速开始

### 1. 安装

把 `extension/` 整个目录拷到：

```
C:\Users\<用户名>\AppData\Roaming\Adobe\CEP\extensions\com.xy.aistudio.cep\
```

最终结构应为：

```
com.xy.aistudio.cep\
├── CSXS\manifest.xml
├── index.html
├── css\  js\  jsx\  icons\
```

### 2. 开启 CEP 调试模式

管理员 CMD 执行（PS 各版本都写一遍最省事）：

```bat
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### 3. 打开面板

重启 Photoshop → **`窗口 > 扩展功能 > AI Studio`**（英文版：`Window > Extensions > AI Studio`）。

> 注意是「窗口」菜单**最底部**的「扩展功能」，不是「增效工具」——「增效工具」里只有 `.8bf` 滤镜和 UXP 插件。

> **`AutoVisible` 必须是 `true`，不能改回 `false`。**
>
> 踩过的坑（2026-10-20 排查一整天）：设成 `false` 时，面板在 PS 26 / CEP 12 上会
> **加载成功但拿不到可见区域** —— 页面在跑（JS 正常、CDP 能截到完整画面、rAF 60fps），
> 屏幕上却是一片灰。这条路上 GPU 驱动、签名校验、窗口层级全是干扰项，查不出问题。
>
> 当初改成 `false` 是为了让面板"手动打开"，顺便规避输入法挂接问题；实测下来
> **CEP 12 上中文输入本来就正常**（此顾虑已不成立），代价却是灰屏，得不偿失。
>
> 不想每次启动自动弹出，正确做法是**收起面板，让 PS 记住工作区状态**
> （`工作区 (Modified)/Essentials.psw` 里 panel 的 `is-closed="true"`），
> 而不是改 `AutoVisible`。

#### 打不上中文时（CEP 通病，非本插件代码问题）

现象：英文能打，切到中文输入法后候选框不出现、字也上不去。这是宿主 CEF 窗口没挂上 Windows 输入法，按顺序试：

1. 面板里先点一下**空白处或页头**，再点输入框（重新激活一次焦点）；
2. 把面板**拖出来浮动**，再点输入框；
3. 在面板内按 `Shift` 或 `Ctrl+Shift` 切一次中英文；
4. 兜底：在记事本里打好中文，`Ctrl+V` 粘进输入框（粘贴文本不会被图片上传逻辑拦截）。

### 4. 配 API

面板右上角点「未配置」→ 到「我的」页填写：

| 字段 | 示例 |
|---|---|
| API 服务地址 | `https://api.your-domain.com` |
| API Key | `sk-xxxx` |
| 模型名称 | `flux-1-schnell` |
| 接口路径 | `/v1/images/generations`（默认，OpenAI 兼容） |
| 请求协议 | `OpenAI 兼容` / `自定义 JSON` |

填完点「测试连接」验证，再点「保存配置」。

> 不填也能用：面板会以本地占位图跑通整套流程（生成 → 缩略图 → 历史 → 插入图层），方便先看 UI。

> 下载的图一律存成 **`.png`**：接口返回 jpeg/webp 时会先用 canvas 无损转码成 PNG 再写盘（尺寸像素不变），避免「后缀 png、内容 jpeg」被 PS 判成格式错误。

## 对话与历史

**智能改图是对话流**：一次生成 = 一轮（用户消息 + AI 回复）。消息里的参考图和结果图都能 hover 出按钮，结果图点「插入图层」会落到 PS 当前选区。

**输入区那两个小图也能点**：点图（或 hover 出来的放大镜）看大图，预览底栏直接有「插入图层」；hover 出的 ＋ 是不看大图直接插。不管图是「读取选区」还是「上传本地」来的，都能这么用 —— 想先在 PS 里比对一下再决定要不要出图，不必先生成。

**「新对话」= 开一个新的对话窗口**：当前这段对话不会丢，整段存档进「历史记录 → 对话记录」，页面清空重来。页头的小标签会显示当前是「新对话」还是「第 N 轮」。

**历史记录两个视图**：

| 视图 | 内容 | 双击 |
|---|---|---|
| 图片记录 | 每张生成结果一条 | 回到生成它的那段对话 |
| 对话记录 | 每段对话一条（轮数 / 张数 / 时间） | 直接打开这段对话 |

双击任意卡片（或点「打开对话」按钮）→ 跳回智能改图页，**整段对话原样恢复**：参考图、提示词、每一轮的结果图都在，仍然可以插入图层、预览、下载、重新编辑、再次生成，也可以接着往下聊。打开时会自动滚到点开的那张图并高亮一下。

> 图片记录上限 60 条；**对话记录不设固定条数**（写在本地文件夹里，只受磁盘限制）。

## 插入的是原图吗？

**新生成的结果：是原图。** 生成时原图会写进 `images/` 目录，会话里只记文件名，插入/预览/下载都按文件名读回原图字节。

**怎么看出来的**：插入完成的提示会把两个尺寸都列出来，格式是「插入后尺寸（原图尺寸）」：

```
已插入选区 700x700（原图 1024x1024）        ← 原图，正常
已插入选区 700x700（原图 360x360），已放大 1.9×，会模糊   ← 用的是缩略图，橙色警告
```

图片右下角的角标也会如实标：有原图时显示生成尺寸（如 `1024×1024`）；**只剩缩略图时显示橙色「仅缩略图」**。

> 提示里之所以要带「原图尺寸」，是因为只报插入后的尺寸没有意义 —— 一张 360 的缩略图被放大铺满 1024 的选区，插入后同样是 1024×1024，光看这个数字分辨不出清晰度。

**升级前的老记录只有缩略图**：当年为了绕开浏览器存储限制，大图在写入时就被换成了 360 缩略图，原图没有留档、无法找回。这批记录会标「仅缩略图」，插入前也会先弹警告 —— 想要清晰版本，重新生成一次即可。

## 默认是智能对象，可以关

插入的图层**默认是智能对象**：原始像素完整保留，缩放只是变换（反复调整不累积损失），双击能编辑原始内容，被选区遮掉的画面用蒙版存着 —— 删掉蒙版就能恢复。

| | 智能对象（默认） | 普通图层（关掉后） |
|---|---|---|
| 缩放 | 变换矩阵，原始像素不动 | 重采样改写像素 |
| 裁边 | 蒙版遮住，**可恢复** | 直接删除，不可恢复 |
| 拿到就画 | 需先栅格化 | 可以直接画笔 |
| 导出 JPG | 平板化 | 平板化 |

图比选区大时（缩小）两者清晰度一样；**图比选区小、需要放大时**，智能对象保留了原始像素，后面想调整还有余地。

想生成完直接涂抹的话，去「我的 → 插入图层方式」关掉开关，之后插入的就是普通栅格化图层。

## 数据存在哪 / 怎么备份

对话和图片默认存到：

```
%APPDATA%\AIStudio\data\
├─ index.json               会话索引（标题 / 时间 / 轮数 / 封面）
├─ sessions\<id>.json       每段对话一个文件（图片只记文件名）
└─ images\<id>.png          结果原图；t_<id>.jpg 是列表缩略图
```

- 「我的 → 对话存储位置」里可以**换文件夹**（比如放到 D 盘或网盘同步目录），切换时会把已有对话和图片一起搬过去，旧目录原样保留。
- 「选择文件夹」打开的是**面板自己的目录浏览器**（不是系统的文件夹对话框）。系统对话框是同步阻塞的，万一被窗口挡住看不见，整个面板会卡住——这也是之前「点了没反应」和之后白屏的原因。现在这一步全程在面板里完成。
- 不想一层层点，也可以把完整路径直接粘到下面的输入框，点「应用」。
- 备份就是复制这个文件夹；换电脑时把它拷到新机器，再在「我的」里指过去即可。
- 「打开文件夹」直接在资源管理器里定位。
- 未连接 Photoshop（浏览器里预览）时没有文件系统，会话退回浏览器存储，最多 8 段。

## 出图不再怕收起面板（异步任务）

默认走**异步出图**：提交请求 0.5 秒就返回，只拿一个任务 ID，之后每隔 6 秒问一次结果。

```
提交  POST /v1/images/generations  {"async": true, ...}
      → {"id":"task_xxx","status":"queued","progress":"20%"}
轮询  GET  /v1/images/generations/task_xxx
      → {"status":"in_progress","progress":"60%"}
      → {"status":"completed","data":[{"url":"https://.../0.jpg"}]}
```

好处是**出图那 40-60 秒可以随便收起面板、甚至关掉重开**：每个轮询请求只有几百毫秒，被掐断也无所谓，下一轮接着问；任务在服务端照跑，任务 ID 在提交那一刻就同步写进了本地存储，面板重开会自己把没跑完的任务接上，跑完自动塞回原来那一轮对话。

- 开关：「我的 → 出图方式」，关掉就退回老的一次请求等到底（不推荐）。
- 出图时消息上会显示 `任务 bcBxKC · 服务端生成中 60% · 这期间可以随便收起面板`。
- 万一还是断了：消息上有个「取回结果」按钮；也可以复制任务 ID，到「我的 → 任务取回」粘贴取回。
- 生成完的图自动存进资料库 `images/` 目录（「我的 → 图片文件夹 → 打开」能直接进资源管理器）。

> 如果用的是不支持 `async` 参数的服务，代码会自动退化为同步模式（`createTask` 里检测不到任务 ID 就按同步结果处理），不会报错。

## 支持的 Photoshop 版本

**Photoshop 2022（23.0）及以上**，下限写在 manifest 的 `Host Version`：`[23.0,99.9]`。

下限定在 2022 是 CSS 卡住的，不是 JS：

| 层 | 情况 |
|---|---|
| JS | 零处现代语法（可选链、`??`、`replaceAll`、`flat` 全无），下探到 CC 2019 也没问题 |
| JSX | 只用 `Mk ` / `newPlacedLayer` 这类 CS 时代就有的 Action Manager API |
| CSS | **卡点**：`flex gap` 要 Chromium 84+，`inset` 要 Chromium 87+，二者都到 CEP 11（PS 2022）才支持 |

`inset` 用在全部 7 处遮罩层（`lightbox` / `modal` / `dp-mask` / `thumb-mask` / `result-mask` / `thumb-acts`）。低版本上遮罩铺不满，**图片预览和确认弹窗会直接失效**，是功能损坏而非单纯难看，所以明确划了这条线。

CEP 与 Chromium 的对应关系：CC 2019/2020 → CEP 9（Chromium 61）、2021 → CEP 10（74）、2022 → CEP 11（88）、2024 → CEP 12（99）。

若要支持 PS 2020 / CC 2019，需先把 CSS 降级：`inset:0` 改写为 `top/right/bottom/left:0`，`flex gap` 用 margin 兜底，并在目标版本真机实测。

## 面板一片灰（只剩标题栏）

**先查 manifest 的 `AutoVisible` 是不是 `true`** —— 这是已知的唯一根因。

设成 `false` 时，面板在 PS 26 / CEP 12 上会「加载成功但拿不到可见区域」：JS 正常跑、DOM 完整、rAF 60fps、通过 CDP 能截到完整画面，屏幕上却是一片灰。排查时很容易被 GPU/Vulkan 驱动冲突、扩展签名缺失、`SetParent` 失败、`parent=0` / `vis=false` 这些现象带偏，它们都不是原因。

另一种情况：面板被收起再展开后偶尔不重绘。这**不是**数据丢失，DOM、状态、历史记录都还在，是 CEP 窗口合成层没刷新。代码里已有自愈：面板重新可见或获得焦点时，`kickRepaint()`（`js/app.js`）会重建渲染层，并在 80ms / 700ms / 1.6s 各补绘一次；正在输入时会跳过，不打断中文输入法。

自愈没覆盖到时，手动逼一下（任选其一，不用重启 PS）：

1. 点一下面板内任意位置（触发 focus，走自愈逻辑）；
2. 拖一下面板与文档之间的**分隔条**，哪怕只动 1px；
3. 把面板标签拖出来变浮动窗口，再拖回去。

## 不装 PS，只看 UI

双击 `extension/index.html` 用浏览器打开。除「插入图层」外全部功能可用（含 mock 生成、历史存取、API 测试）。

## 调试

`extension/.debug` 已开远程调试端口。装好后 Chrome 打开 <http://localhost:8701> 查看 console / 网络。
发布时删掉 `.debug` 文件。

## 改自己的 API
只有一个文件要动：`js/api.js` 的 `buildCustomPayload()`。
请求头、路径、超时都在「我的」页配，不用改代码。
返回结构不同时改 `parseResponse()`。

详见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录

```
extension/
├── CSXS/manifest.xml   CEP 清单
├── index.html          入口
├── css/theme.css       主题变量与通用组件
├── css/app.css         页面布局
├── js/util.js          工具
├── js/CSInterface.js   精简版 CEP 宿主接口垫片（evalScript / 系统路径 / 事件）
├── js/store.js         状态 + 资料库读写
├── js/library.js       ★ 对话资料库（索引 / 会话 JSON / 目录切换）
├── js/api.js           ★ 自定义 API 适配层（同步 generate + 异步 createTask/pollTask）
├── js/tasks.js         ★ 异步任务登记与断点续取（localStorage + resume）
├── js/ps.js            CEP ↔ PS 桥
├── js/ui.js            公共组件
├── js/uploader.js      上传区
├── js/app.js           路由
├── js/pages/           4 个页面
├── jsx/host.jsx        ExtendScript（插入图层 / 读取选区）
└── icons/              图标
```
