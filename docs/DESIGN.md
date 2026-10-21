# AI Studio CEP —— 智能改图插件扩展工程说明

> 本文对应交付物 ①②③④。
> 界面为自研实现，深色配色与 Photoshop 面板风格保持一致。
> 工程内不硬编码任何第三方接口地址或密钥 —— API 地址由使用者在面板内自行填写。

---

## ① 页面结构 / 组件清单 / 路由关系

### 1.1 路由表

Hash 路由，`js/app.js` 内 `TABS` 常量即唯一真源。

| 路由 | 页面 | 模块文件 | 说明 |
|---|---|---|---|
| `#/edit` | 智能改图 | `js/pages/edit.js` | 默认页 |
| `#/generate` | AI 生图 | `js/pages/generate.js` | 文生图 / 图生图 |
| `#/history` | 历史记录 | `js/pages/history.js` | 本地 localStorage |
| `#/mine` | 我的 | `js/pages/mine.js` | API 配置面板 |

跳转规则：

```
顶部 Tab ──┬─→ #/edit
           ├─→ #/generate
           ├─→ #/history
           └─→ #/mine

结果卡「重新编辑」 ─→ 写入 intent ─→ #/edit 或 #/generate（自动回填）
历史卡「重新编辑」 ─→ 写入 intent ─→ 同上
页头「历史」按钮   ─→ #/history
右上角 API 徽标    ─→ #/mine
```

- 切换 Tab 时**整页重挂载**（`view.innerHTML = render()` + `bind()`），表单值存于 `store.state.edit / .generate`，因此不丢草稿。
- 跨页传参用 `store.setIntent()` / `store.takeIntent()`（一次性消费），避免全局变量污染。

### 1.2 通用组件清单（`js/ui.js`）

| 组件 | 类名 | 用途 |
|---|---|---|
| Tab 导航 | `.sp-tabs` / `.sp-tab` | 顶部 4 页切换，选中 3px 蓝色下边线 |
| 折叠面板 | `.sp-drop-down` | 高级设置，箭头旋转 |
| 主按钮 | `.btn-primary` | 生成 CTA |
| 次级按钮 | `.btn` | 卡片操作、页头操作 |
| 危险按钮 | `.btn-danger` | 删除、清缓存 |
| 输入框 / 文本域 / 原生下拉 | `.input` / `.textarea` / `.select-native` | 统一 `#333` 底、`rgba(255,255,255,.1)` 描边、聚焦变主题蓝 |
| 标签 | `.tag` + `tag-accent/success/warn/danger` | 模型标签、状态 |
| Chip 筛选 | `.chip` | 历史页筛选、风格选择 |
| Toast | `.toast` | 底部轻提示，2s / 3.2s |
| Lightbox | `.lightbox` | 图片全屏预览 |
| 确认弹窗 | `.modal` | 删除 / 清空二次确认 |
| 结果卡片 | `.result-card` | 智能改图 / AI 生图共用 |
| 空状态 | `.empty` | 无数据占位 |
| 骨架屏 | `.result-skeleton` + `.spinner` | 生成中 |

### 1.3 智能改图页（`#/edit`）

```
.page.chat#editPage                     ← 固定头 / 滚动区 / 固定输入区
├─ .chat-head                            flex: 0 0 auto
│   ├─ .chat-head-row
│   │   ├─ .chat-title「智能改图」+ .chat-sess（新对话 / 第 N 轮）
│   │   └─ .chat-head-actions → 「新对话」「历史」
│   └─ .chat-params
│       ├─ select#editModel               模型（modelCache → modelList → model）
│       ├─ select#editRatio               输出比例（.chat-mini）
│       └─ select#editCount               生成张数（.chat-mini）
├─ .chat-body#chatBody                   flex: 1 1 auto；overflow-y: auto
│   ├─ .msg.msg-user                    右对齐
│   │   ├─ .msg-imgs → .msg-thumb × N
│   │   │   └─ .thumb-mask（hover 显示）
│   │   │        └─ .ico-btn 预览 · .ico-btn 下载
│   │   └─ .msg-text                    提示词气泡
│   └─ .msg.msg-ai                      左对齐
│       ├─ .msg-avatar「AI」
│       └─ .msg-bubble
│           ├─ .msg-loading / .msg-error
│           ├─ .msg-results → .msg-result × N
│           │   └─ .result-mask（hover 显示）
│           │        ├─ .mask-insert    大面积「＋ 插入图层」
│           │        └─ .mask-foot → 预览 · 下载
│           └─ .msg-actions → 重新编辑 · 再次生成
└─ .chat-composer#composer               flex: 0 0 auto
    ├─ .composer-thumbs#editThumbs       待发送图（主图/参考N）
    │   ├─ img                            点击 = 看大图
    │   ├─ .thumb-acts（hover 显示）
    │   │   ├─ [data-view]                放大镜：看大图（预览层里有「插入图层」）
    │   │   └─ [data-ins]                 ＋：直接插入 PS 当前文档
    │   ├─ .thumb-tag                     主图 / 参考1 / 参考2
    │   └─ .thumb-del                     右上角 ×：移除
    ├─ .composer-tools
    │   ├─ button[data-act=pickSel]      读取选区（PS）
    │   ├─ button[data-act=pickFile]     上传本地
    │   └─ input[type=file]#editFile     隐藏
    ├─ textarea#editPrompt
    └─ .composer-foot → 字数 + button#editRun「生成」
```

**交互要点**

| 元素 | 行为 |
|---|---|
| 参考图 hover | 遮罩淡入，显示预览/下载两个图标按钮 |
| 结果图 hover | 遮罩淡入：上方大按钮「＋ 插入图层」，底部「预览」「下载」 |
| 输入区缩略图 | 点图片或放大镜 = 全屏预览（底栏带「插入图层」）；点 ＋ = 直接插入 PS 当前选区；右上 × 移除。主图/参考图都适用 |
| 图层面板命名 | 输入区插入的图层叫「主图_<时间戳>」/「参考1_<时间戳>」，和结果图的「改图_」区分开 |
| 生成 | 立即追加一条用户消息 + 一条 AI 占位消息，输入区清空 |
| 生成中 | AI 消息显示 spinner；失败则显示 `.msg-error` |
| 重新编辑 | 把该轮提示词 + 参考图回填到输入区，聚焦输入框 |
| 再次生成 | 用该轮提示词 + 参考图直接再发一次 |
| 新对话 | 开一个新的**对话窗口**：当前这段对话整体存档（历史 → 对话记录，可双击重新打开），页面清空。二次确认 |
| Ctrl/⌘ + Enter | 直接生成 |

### 1.4 AI 生图页（`#/generate`）

```
.page#genPage
├─ .page-head（标题 + 副标题 + 历史入口）
├─ .section（提示词）
│   ├─ textarea#genPrompt（96px 高，800 字）
│   └─ .chips#genStyles（写实摄影 / 电商白底 / 场景合成 / 3D 渲染 / 插画 / 赛博朋克，可反选）
├─ .section（参数）
│   ├─ 模型下拉#genModel
│   └─ .grid-2 → 比例 / 张数
├─ .section（参考图，可选）
│   ├─ .upload-zone#genDrop（72px 矮版）
│   ├─ .thumb-strip#genThumbs
│   └─ .sp-drop-down > textarea#genNegative
├─ .generate-bar > button#genRun
└─ .section（结果）> .result-list#genResults（同 5 按钮卡）
```

与智能改图的差异：参考图非必填、有风格 chip、提示词更长。**结果卡组件与操作完全复用**。

### 1.5 历史记录页（`#/history`）

两个视图，用 `.seg`（分段控件）切换，选择记在 `aistudio.ui.v1`，下次打开还是那一页。

```
.page#histPage
├─ .page-head（标题 + 「本地保存 · 共 N 条 / 共 N 段对话」+ 清空）
├─ .seg#histSeg（图片记录 | 对话记录）
├─ .history-bar
│   ├─ 图片视图 → .chips（全部 / 智能改图 / AI生图）
│   └─ 对话视图 → .hist-tip（双击对话即可重新打开…）
└─ .history-list#histList
    ├─ 图片视图 .hist-card[data-id]
    │   ├─ .hist-thumb（76×76 + 类型角标 + 蓝色「对话」角标，单击预览）
    │   └─ .hist-body
    │       ├─ .hist-prompt  提示词预览（2 行截断）
    │       ├─ .hist-meta    时间 · 模型 · 尺寸
    │       └─ .hist-actions 打开对话 / 重新编辑 / 下载 / 删除
    └─ 对话视图 .hist-card[data-sid]
        ├─ .hist-thumb（末张结果缩略图 + 「对话」角标）
        └─ .hist-body
            ├─ .hist-prompt  会话标题（首条用户提示词）
            ├─ .hist-meta    N 轮 · M 张图 · 相对时间 · 模型
            └─ .hist-actions 打开对话 / 删除
```

空态：`.empty`（"暂无图片记录 / 暂无对话记录"）。

**双击 = 回到那段对话**（两个视图都支持）：

```
双击 .hist-card
 ├─ 图片记录 → 用 entry.sessionId 找到会话 → openSession → 跳 #/edit
 │              没有 sessionId（升级前的老记录）→ buildLegacySession 现场补一段单轮会话
 ├─ 对话记录 → 直接 openSession(sid) → 跳 #/edit
 └─ AI 生图条目（非对话流）→ 退化成预览
```

单击缩略图预览会延迟 200ms 执行 —— 否则双击的第一下就把 Lightbox 打开了，双击永远落不到卡片上。

### 1.6 我的页（`#/mine`）

```
.page#minePage
├─ .profile-card  头像 + 「本地工作台」+ 配置状态标签
├─ .notice        说明：API 地址由使用者自行填写
├─ .section「API 服务配置」
│   ├─ input#cfgBaseUrl      API 服务地址（必填）
│   ├─ input#cfgApiKey       密码框 + 显示/隐藏
│   ├─ input#cfgModel        模型名称（可手填）
│   ├─ button#cfgPull        拉取模型 → GET /v1/models
│   ├─ #modelPicker          拉取结果：提示行 + select#modelPick（★ 标生图模型）
│   ├─ input#cfgPath         接口路径（默认 /v1/images/generations）
│   ├─ .grid-2 → select#cfgProtocol（OpenAI 兼容 / 自定义 JSON）+ input#cfgTimeout
│   ├─ 按钮行：测试连接 / 保存配置
│   ├─ #cfgTest              连通性结果区
│   └─ .sp-drop-down「高级设置」
│       ├─ textarea#cfgModelList  常用模型（逗号分隔，供下拉；与拉取结果合并）
│       └─ textarea#cfgHeaders    额外请求头（Key: Value 每行一条）
├─ .section「本地缓存」
│   ├─ .cfg-row 图片记录 N 条 → 清理历史
│   ├─ .cfg-row 对话记录 N 段 → 查看（跳历史·对话记录）
│   └─ .cfg-row 全部本地缓存  → 清理缓存（二次确认）
└─ .foot-note 版本 + Photoshop 连接状态
```

---

## ② 技术方案

### 2.1 选型结论

| 项 | 选择 | 理由 |
|---|---|---|
| 宿主 | **CEP 11**（Photoshop 2022+） | 用户指定；CEP 是 Chromium 内核，Web 技术零改造 |
| 前端 | **原生 HTML + 经典 JS（IIFE 命名空间 `window.HH`）** | 免构建、免 npm、拷进目录即可加载；CEP 里 `file://` 下 ES Module 会被 CORS 拦，经典脚本最稳 |
| 样式 | 原生 CSS + CSS 变量 | 主题 token 集中，改色只动 `:root` |
| 状态 | 自研极简 store（`js/store.js`） | 4 个页面的复杂度用不上 Redux |
| 持久化 | `localStorage` | 配置 + 历史；分层降级防配额溢出 |
| 宿主交互 | `CSInterface.evalScript` + ExtendScript | 插入图层 |
| 图标 | 本地 PNG | 无外链，离线可用 |

> 为什么不用 React：CEP 里 React 需要 webpack/vite 预编译，改一行要重构建，
> 为了"改完刷新面板就能看到"这个开发体验，重造一套构建链不值得。当前方案 0 依赖。

### 2.2 目录结构

```
AIStudio-CEP/
├── docs/DESIGN.md              本文件
├── README.md                   安装 / 调试说明
└── extension/                  ← 整个目录拷入 CEP extensions
    ├── CSXS/manifest.xml       CEP 清单（BundleId / 尺寸 / CEF 参数）
    ├── .debug                  远程调试端口 8701（发布前删除）
    ├── index.html              唯一 HTML 入口（骨架 + 脚本按序加载）
    ├── css/
    │   ├── theme.css           主题变量 / 重置 / 通用组件
    │   └── app.css             4 个页面的布局样式
    ├── js/
    │   ├── util.js             DOM / 时间 / 图片压缩 / 下载（统一转 PNG）/ 懒加载
    │   ├── store.js            状态 + 资料库读写 + localStorage 兜底
    │   ├── api.js              ★ 自定义 API 适配层（唯一出网口）
    │   ├── ps.js               CEP ↔ Photoshop 桥（含原图/缩略图落盘）
    │   ├── library.js          ★ 对话资料库：索引 / 会话 JSON / 目录切换
    │   ├── ui.js               Toast / 预览 / 确认 / 卡片 / 折叠面板
    │   ├── uploader.js         上传区（点击/拖拽/粘贴）
    │   ├── app.js              Tab 导航 + Hash 路由
    │   └── pages/
    │       ├── edit.js         智能改图
    │       ├── generate.js     AI 生图
    │       ├── history.js      历史记录
    │       └── mine.js         我的 / API 配置
    ├── jsx/host.jsx            ExtendScript（插入图层）
    └── icons/                  panel.png / panel@2x.png / tab.png
```

### 2.3 本地存储设计

| Key | 内容 |
|---|---|
| `aistudio.api.v1` | `{ baseUrl, apiKey, model, path, protocol, timeout, modelList, modelCache, modelCacheAt, extraHeaders }` |
| `aistudio.history.v1` | 图片记录数组（见下） |
| `aistudio.sessions.v1` | 对话会话数组（**仅在未连接 PS / 未启用资料库时使用**，见 2.4） |
| `aistudio.ui.v1` | `{ historyView, historyFilter }` 上次停留的视图 |
| `aistudio.library.v1` | `{ dir }` 对话资料库文件夹（「我的」里可改） |

单条历史结构（每条 = 一张结果图）：

```js
{
  id: 'g_xxx',
  page: 'edit' | 'generate',
  prompt: '...',
  model: 'flux-1-schnell',
  size: '1024×1024',                     // 请求的尺寸（展示用）
  px: '1024×1024',                       // 实际像素（结果图角标）
  createdAt: 1760000000000,
  thumb: 'data:image/jpeg;base64,...',   // 360px，约 20-40KB，localStorage 里常驻
  file: 'g_xxx.png',                     // ★ 原图文件名，实际存在 %APPDATA%/AIStudio/cache
  full: 'data:image/...',                // 仅旧版本记录 / 无磁盘环境时才会出现的内联原图
  srcThumb: '...',                       // 改图页的原图缩略，供「重新编辑」回填
  sessionId: 'ss_xxx',                   // ★ 归属会话：双击卡片靠它把整段对话捞回来
  msgId: 'm_xxx'                         // ★ 归属的那条 AI 消息
}
```

**原图为什么落盘（重要）**

`localStorage` 只有 5MB，一张 1024 PNG 就 1~3MB。早期版本为防爆配额，代码里写了
`full: dataUrl.length < 900000 ? dataUrl : thumb` —— 超过 900KB 的图直接把**缩略图当原图存**，
于是历史里点预览/下载拿到的是 360px（用户报的「下载 360×360」就是这个）。

现在改成：生成完成后 `HH.ps.persistImage(id, dataUrl)` 把原图写进
`%APPDATA%/AIStudio/cache/<id>.<ext>`，`localStorage` 只记文件名。
预览 / 下载 / 插入图层统一走 `HH.ps.resolveImage(item)`：**内存原图 → 磁盘缓存 → 缩略图**。

- 目录用 `Folder.userData`（`%APPDATA%`）而不是 Temp，避免被系统清理后历史读不到原图；
- `cep.fs.readFile(path,'Base64')` 每 72 字符会插一个换行，拼 dataURL 前要 `replace(/\s+/g,'')`；
- 删记录 / 清空历史 / 超出 60 条淘汰时，会顺手 `cacheRemove` 删掉磁盘文件，避免缓存目录只增不减；
- 老记录若 `full === thumb`（说明当年就只存了缩略图），卡片上标「仅缩略图」，原图已无法找回。

### 2.4 对话资料库（本地文件夹，v1.3 起）

```
<dir>/                      默认 %APPDATA%/AIStudio/data，可在「我的」里换
├─ index.json               会话索引：标题 / 时间 / 轮数 / 张数 / 封面文件名
├─ sessions/<id>.json       单段对话的完整消息（图片只记文件名，不内联）
└─ images/<id>.png          结果原图；t_<id>.jpg 是列表用的缩略图
```

**为什么改成文件夹**：`localStorage` 只有 5MB，之前只能「最多保留 8 段对话」。落盘后条数只受磁盘限制
（代码里留了 `KEEP_SESS = 300` 兜底），而且用户能在资源管理器里直接备份、拷走。

**启动流程**（`store.bootLibrary`）：
1. `HH.lib.init()` 建目录（`__aiEnsureDir` 逐级创建）；
2. `readIndex()` 只读 `index.json`（几 KB），把每段做成「壳会话」：`{ id, title, updatedAt, stats, cover, _disk: true, messages: [] }`；
3. 列表用索引里的元数据渲染，**不读消息体**，几百段也能秒开；
4. 双击某段 → `HH.lib.loadSession(id)` 读那一个 JSON → 填回 `messages` → `_disk = false`。

**写入**（`store.persistToDisk`）：
- 只写 `updatedAt` 变了的会话（`diskStamp` 记录上次写入时间），其余只更新索引；
- 壳会话（还没加载消息）**不写文件**，否则会把磁盘上的内容清空；
- 写完把 `aistudio.sessions.v1` 从 localStorage 删掉，释放那 5MB 配额。

**图片与 file:// 的坑**：
- `images/` 就是 `ps.cacheDir()` 的首选目录，结果图的 `file` / `thumbFile` 字段指向这里的文件名；
- CEP 面板是 `file://` 页面，**加载不了其它 file:// 图片**（实测 `<img>` 的 `naturalWidth = 0`，
  即使 manifest 里已经加了 `--allow-file-access-from-files`）；
- 所以渲染统一走 `U.lazyImg(file)`：先用 `data-file` 占位，`cep.fs.readFile` 读成 dataURL 后回填，
  同一张图只读一次并缓存，后续渲染同步命中。

**切换文件夹**（「我的 → 选择文件夹」打开**面板内的目录浏览器**，或直接粘贴路径点「应用」）：
读旧目录全部会话 → `__aiCopyFiles` 复制 `images/` → `lib.setDir(新目录)` → `rewriteLibrary()` 重写索引与 JSON。
旧目录原样保留（相当于一次备份）。

**目录选择不使用任何系统对话框**。两条路都试过，都有致命问题：

| 方案 | 问题 |
|---|---|
| ExtendScript `Folder.selectDialog` | 同步模态、跑在 **PS 主线程**上；PS 版本里 `Folder` 实例没有这个方法（抛 `不是函数`），且对话框会被面板压住，一旦弹出就锁死 PS |
| `cep.fs.showOpenDialogEx` | 不锁 PS，但**同步阻塞面板 JS 线程**；被窗口层级挡住时用户看不到对话框，面板就永远停在「选择中…」，只能重开面板甚至重启 PS（实测会白屏） |

所以改成面板内自建浏览器：`HH.lib.listDir(path)` 用 `cep.fs.readdir` 列子目录，配合
`parentOf / joinPath / isRoot` 做「上一级 → 进入 → 选这个文件夹」。全程在页面里，不碰宿主对话框，
最坏情况只是列表读不出来，随时能点取消退出。

**清理**：`清空对话` 只删 `sessions/*` 与图片；`清理缓存` 连 `index.json` 一起清。

单段会话结构（`aistudio.sessions.v1` 里的一条 = 一个对话窗口）：

```js
{
  id: 'ss_xxx',
  page: 'edit',
  title: '将图中的...替换为图2中的台灯',   // 首条用户提示词截断 24 字
  createdAt, updatedAt,
  model, ratio,
  messages: [
    { id, role: 'user', prompt, images: [{ id, name, w, h, dataUrl }], createdAt },
    { id, role: 'assistant', status: 'done'|'error', prompt, model, ratio,
      createdAt,
      results: [{ id, thumb, px, size, prompt, model, createdAt }] }  // id 与历史条目对齐
  ]
}
```

**两套存储的分工**

- 原图只存一份，活在 `images/` 里的 `history.file`；会话 JSON 只放 `thumbFile`/`file` 文件名，一段 3 轮的对话 JSON 约 1-2KB。
- 打开会话时 `hydrateSession()` 用 `results[].id` 回查 `history`，把 `file` 挂到结果上；用到时 `resolveImage()` 再读盘，所以插入图层 / 下载拿到的仍是原图，不是缩略图。
- 老会话被配额降级成「无图」也能正常打开，靠 history 回填。
- 注意 `dataUrl` 字段的语义是「原图」，**不要把 thumb 塞进去**（塞了之后 resolve 会把 360px 当原图直接用）。

**配额策略**

| 存储 | 策略 |
|---|---|
| 历史图 | 原图在磁盘上，localStorage 只放 360px 缩略图（约 20-40KB/张），60 条也就 2MB 左右；`persistHistory` 的 `保留 8 条原图 → 4 → 2 → 0` 只对**旧版本内联 full** 生效 |
| 会话（资料库可用） | 每段一个 JSON 写进 `<dir>/sessions/`，条数只受磁盘限制（`KEEP_SESS = 300` 兜底）；localStorage 不存会话 |
| 会话（无 PS / 浏览器预览） | 退回 `localStorage`，按 `updatedAt` 取前 8 段；超限依次 `8 段含图 → 6 → 3 → 8 段无图 → 4 段无图` |

**上限**：`MAX_HISTORY = 60` 张、`KEEP_SESS = 300` 段（磁盘）/ `LS_SESS = 8` 段（localStorage）、单段 `MAX_SESS_MSGS = 60` 条消息。

### 2.5 PS 选区读图（`ps.readSelection`）

面板不能直接访问 Photoshop 文档，走三步：

```
面板 js/ps.js                     JSX jsx/host.jsx                面板 js/ps.js
readSelection() ──evalScript──→ __aiGetSelection()
                                    ├─ doc.selection.bounds        取选区（无选区则整画布）
                                    ├─ selection.copy()
                                    ├─ documents.add(w,h,分辨率,RGB/8bit/sRGB)
                                    ├─ paste() + flatten()
                                    ├─ 超 4096px 等比缩小
                                    └─ saveAs → Temp/aistudio_sel_*.png
                                ←── "OK:路径|WxH|1|left,top"
                                  ├─ cep.fs.readFile(path,'Base64')
                                  └─ cep.fs.deleteFile(path) → dataURL
```

几个必须踩对的点：

1. **分辨率要跟原文档一致**（`documents.add` 第 3 个参数用 `doc.resolution`），否则 paste 会按物理尺寸缩放。
2. **`app.displayDialogs = DialogModes.NO`**，否则「粘贴配置文件」弹窗会卡死脚本；异常分支里也要恢复。
3. **选区 bounds 可能是 `UnitValue` 也可能是数字**，统一用 `px(v)` 兜底（`v.as('px')` 失败则 `Number(v)`）。
4. **图片不经过 evalScript 回传**：只回传路径，base64 由 `cep.fs` 读。大图 base64 走 JSX 字符串会轻易超过 CEP 的回传上限。
5. 无选区时 `selectAll → copy → deselect`，不改变用户原有状态。

### 2.6 插入图层：按选区对齐（`__aiInsertLayer`）

生成图尺寸和选区尺寸往往不一致（生成 2K、选区只有 1K）。插入规则：

| 情况 | 行为 |
|---|---|
| **有选区** | 等比放大到**铺满**选区（cover）→ 居中到选区中心 → `selection.invert(); clear(); invert()` 把溢出选区的部分裁掉，并还原用户选区 |
| 无选区 | 等比缩放到**放得下**整张画布（contain，小图不放大）→ 居中 |

```
面板 js/ps.js                 JSX jsx/host.jsx
insertImage(src,'改图','selection')
  ├─ toDataURL(src)
  ├─ Temp 目录（问 JSX 要 Folder.temp.fsName）
  ├─ cep.fs.writeFile(path, base64,'Base64')
  ├─ evalScript('__aiInsertLayer(path, hint, "selection")')
  │     ├─ doc.selection.bounds → 目标矩形
  │     ├─ 打开生成图 → resizeImage(目标尺寸, BICUBICSHARPER)
  │     ├─ activeLayer.duplicate(targetDoc)
  │     ├─ translate() 对齐选区中心
  │     └─ 反选 clear 裁边 → 恢复选区
  └─ 删除临时文件 → { name, mode, size }
```

返回值 `"OK:图层名|sel|400x400"` 会被解析成 `{name, mode, size}`，面板提示
「已插入选区：400×400（按选区铺满并裁边）」或「已插入图层：…（无选区，按画布居中）」。

> 为什么要 `activeLayer.duplicate` 而不是 `paste()`：paste 会受「当前图层是否锁定/隐藏」「剪贴板内容」影响，
> duplicate 是图层级操作，稳定得多。

### 2.7 JSX 热加载

CEP 的 `<ScriptPath>` **只在扩展首次加载时执行一次**，改完 `host.jsx` 后重载面板仍会跑旧函数。
所以 `js/app.js` 初始化时会调 `ps.loadJSX()`：用 `cep.fs.readFile` 读回 `jsx/host.jsx`，
去掉 `#target` 行后 `evalScript` 重推一遍，带 6 次重试（宿主接口就绪有延迟）。


---

## ③ 交互逻辑说明

### 3.1 页面切换

1. 点 Tab → `location.hash = '#/xxx'`。
2. `hashchange` → `mount()`：写 `state.route` → 消费 intent → 重绘 Tab → `view.innerHTML = page.render()` → `page.bind(view)`。
3. 表单草稿在 `state.edit / state.generate`，重挂载后 `render()` 直接回填，所以切页不丢。

### 3.2 图片上传（`js/uploader.js`）

- 触发：点击上传区 / 拖拽入区（`is-drag` 高亮）/ `Ctrl+V` 粘贴（仅当该页处于激活路由）。
- 校验：MIME 限 `png/jpeg/webp/bmp`，单张 ≤ 10MB（`MAX_MB`），改图最多 3 张、生图最多 2 张。
- 流程：`File → FileReader.readAsDataURL → state.xxx.images.push` → `renderStrip()`。
- 删除：hover 缩略图出现 `×`，点击按 `data-del` 移除。

### 3.3 生成与结果回显

```
点击「生成」
 ├─ 校验：提示词非空；改图页必须 ≥1 张原图
 ├─ state.xxx.running = true → 按钮置灰「生成中…」+ 结果区插入骨架屏
 ├─ HH.api.generate({ mode, prompt, negative, model, ratio, count, images })
 │    ├─ 已配置 API → POST 自定义服务
 │    └─ 未配置     → mock 本地占位图（Canvas 绘制，验证流程用）
 ├─ 每张结果：U.thumb(360) 存缩略图，U.thumb(1024) 存原图，写 state.xxx.results
 ├─ 同时 S.addHistory(...) 落 localStorage
 └─ running=false → 重绘按钮 + 卡片列表，Toast 提示
```

结果卡按钮行为：

| 按钮 | 行为 |
|---|---|
| 插入图层 | `imageInfo()` 取原图并判明是否缩略图 → `HH.ps.insertImage(dataUrl)`：写临时 PNG → 默认 `evalScript('__aiInsertSmart(path)')`（智能对象，可在「我的」关掉，退回 `__aiInsertLayer`）→ PS 中置入新图层。提示语为「已插入选区 700x700（原图 1024x1024）」，**放大超过 1.05× 时升级为警告**并标出倍数（见 3.3.1 / 3.3.2） |
| 预览 | `resolveImage()` 取原图 → Lightbox 全屏查看 + 时间/模型/真实像素 |
| 下载 | `resolveImage()` 取原图（不是 360 缩略图）→ `U.toPng()` 用 canvas 重新编码成 **真正的 PNG**（接口常返回 jpeg/webp，直接改后缀会被 PS 判成格式不符）→ `cep.fs.showSaveDialogEx` + `writeFile`，文件名一律 `.png` |
| 重新编辑 | 提示词/模型回填表单；有原图缩略则一并回填，滚回顶部 |
| 再次生成 | 用该卡片参数重跑一次（同图同词） |

#### 3.3.1 插入图层：怎么确认插的是原图而不是缩略图

**结论**：新生成的结果插入的是原图；升级前的老记录只有缩略图，插进去会被放大变糊。

链路：`onInsert → withFullImage → HH.ps.imageInfo(item) → resolveImage → insertImage → __aiInsertLayer`

`resolveImage` 的优先级是 `dataUrl/full`（内存原图）→ `file`（磁盘原图）→ `thumb`（缩略图兜底），
**只有前两者都缺失才会用到缩略图**。新生成的图一律走「原图写盘 + 会话只记文件名」，所以拿回的是原图像素。

**但以前的提示语无法验证这件事**：`__aiInsertLayer` 只返回插入后的 `bounds`，
于是「1024 原图插进 1024 选区」和「360 缩略图被放大 2.8 倍插进 1024 选区」返回的都是 `1024x1024`。
用户看到「已插入选区：1024x1024」以为插的是原图，实际可能是糊的。

现在改为回传**两段尺寸**：

```
OK:图层名|sel|源图宽x源图高|插入后宽x插入后高
```

面板据此给出可验证的提示：

| 情况 | 提示 | 类型 |
|---|---|---|
| 原图插入 | `已插入选区 700x700（原图 1024x1024）（铺满选区并裁边）` | ok |
| 缩略图被放大 | `已插入选区 700x700（原图 360x360），已放大 1.9×，会模糊` | warn |
| 前置提醒 | `注意：原图已丢失，当前只有 360×360 缩略图（应为 1024x1024），放大会模糊` | warn |

图片角标同样如实反映：**没有原图来源（`file`/`dataUrl`/`full`）时显示橙色「仅缩略图」**，
而不是照着 `size` 字段显示 `1024×1024`（那只是当年的**期望**尺寸，不代表还有原图）。

`HH.ps.imageInfo(item)` 返回 `{url, w, h, source, lowRes, expect}`，判 `lowRes` 的三条依据：
解析结果就是 thumb 分支、实测比 `size` 字段小 15% 以上、最大边 ≤ 400px（缩略图统一 360）。

#### 3.3.2 两种插入方式：智能对象（默认）vs 栅格化

`__aiInsertLayer`（旧）与 `__aiInsertSmart`（新）的差异：

| | 智能对象（默认） | 普通图层（可关） |
|---|---|---|
| 缩放 | `layer.resize` —— 变更换矩阵，**原始像素不动** | `resizeImage` —— **改写像素**，1024 缩到 860 后原始数据消失 |
| 裁边 | 选区转**图层蒙版**，删蒙版即可恢复被遮的画面 | `selection.clear()` **删除**像素，不可恢复 |
| 后续调整 | 反复缩放不累积损失，双击可编辑原始内容 | 放大就插值，越调越糊 |
| 直接编辑 | 画笔/多数滤镜要先栅格化 | 拿到手直接能画 |
| 导出 JPG/PNG | 平板化，中间的保留不进成品 | 同样平板化 |

**为什么默认选智能对象**：收益不在画质（缩小本来就不损失），而在**可逆**。
cover 算法在比例不一致时会裁掉一部分画面，硬删之后发现构图不对就找不回来了；
用蒙版则随时能恢复。放大场景（图比选区小）下智能对象也保留了翻盘余地。

实现要点：
- 转智能对象用 `executeAction(stringIDToTypeID('newPlacedLayer'))`，**转换后图层引用会失效，必须重新 `activeLayer` 取一次**。
- 蒙版用 `Mk` + `Nw/Chnl` + `Usng/UsrM/RvlS`（Reveal Selection），比矢量蒙版更通用（适配非矩形选区）。
- `layer.resize(百分比, 百分比, AnchorPosition.MIDDLECENTER)`，等比对智能对象是变换。
- 转智能对象失败时 `isSmart=false` 静默退回普通图层，不中断插入。
- 返回值最后追加 `|smart|raster`，蒙版失败再追加 `|nomask`；`parseInsertResult` 按**字段特征**识别（尺寸 / 类型 / 标记），不按下标硬取，以后加字段不会串位。

开关：`state.ui.insertSmart`（默认 true）持久化在 `aistudio.ui.v1`，
「我的 → 插入图层方式」可切换，切换时同步 `HH.ps.setSmartInsert()`。

#### 3.3.3 老数据里的「假原图」

旧版本为绕开 localStorage 5MB，把超过 900KB 的原图换成 360 缩略图后写进 `full`，
于是那批记录的 `full === thumb`。`store.fixHistory()` 在加载时识别这种情况：
清空假的 `full`、打上 `lowRes` 标记，让后续预览/下载/插入都如实提示。

**这批老图的原图无法找回**（当年就没存），要清晰版本只能重新生成一次。

### 3.4 历史卡片操作

- **双击卡片 / 打开对话**：回到这段对话，见 3.5。
- **重新编辑**：改图条目 → 回 `#/edit` 并回填 prompt + 原图缩略；生图条目 → 回 `#/generate` 回填 prompt（走 `store.setIntent`）。
- **下载**：`full || thumb`，文件名带时间顺序无关的唯一后缀。
- **删除**：`HH.ui.confirm` 二次确认 → `store.removeHistory(id)` → 重绘列表。会话本身不受影响，只是那张图退化成缩略图。
- **筛选**：`state.ui.historyFilter` ∈ `all|edit|generate`，切换后整页重绘。
- **清空**：二次确认，只清图片记录；对话记录要单独在「对话记录」视图里删。

### 3.5 对话与会话模型

一条铁律：**`state.edit.messages` 始终是当前会话对象的 `messages` 数组本身（同一引用）**，不是副本。`push` 进去就等于写进了会话，不需要回写同步。

```
store.ensureSession()   取当前会话；没有就新建，并把 state.edit.messages 指过去
store.touchSession()    刷新 title（首条用户提示词）/ updatedAt / model / ratio
store.saveSessions()    瘦身后落盘（丢原图、丢 refImages、running → error）
store.newSession()      存档当前 → 建新会话 → messages 指向空数组
store.openSession(id)   生成中禁止切换 → hydrate 补图 → 换引用 → emit
store.removeSession(id) 删会话；删的是当前则新建一个空会话
```

生成流程里会话相关的三个落盘点：

| 时机 | 动作 | 目的 |
|---|---|---|
| 点「生成」后立刻 | `touchSession` + `saveSessions` | 面板中途关掉也不丢这一轮 |
| 每张结果进 `addHistory` | 带上 `sessionId` / `msgId` | 双击历史卡片可以反查会话 |
| 生成成功 / 失败 | `touchSession` + `saveSessions` | 更新标题与时间，进「对话记录」列表 |

打开历史对话的完整链路：

```
history 页双击
 └─ store.openSession(sid)        // 会话就位、messages 换引用
    store.setIntent({ page:'edit', sessionId, focusResult })
    location.hash = '#/edit'
       └─ app.mount → applyIntent  // 有 sessionId 就不回填表单，只 toast「已打开历史对话 · N 轮 M 张图」
                     → edit.bind   // 读 ui.focusResult → scrollIntoView + 高亮 2.2s
```

「新对话」不是清空，而是**换窗口**：旧会话原样留在「对话记录」里，随时可以双击回来接着聊、接着插入图层。

### 3.6 【我的】API 参数读取与传参

```
输入框 input 事件 ──→ 只写内存 state.api（不落盘、不重绘，避免打字掉焦点）
输入框 change 事件 ─→ 写内存 + localStorage.setItem + 刷新顶部徽标
「保存配置」      ──→ collect() 读全部输入框 → store.saveApi() → Toast + 重绘
「测试连接」      ──→ collect() → HH.api.testConnection(draft)
「拉取模型」      ──→ collect() → HH.api.fetchModels(draft) → 渲染 #modelPicker
```

- **测试连接**不动已保存配置，用屏幕上当前值测，测完不落盘。
- 探测顺序（`modelsUrls()` 生成候选）：`{base}/v1/models` → `{base}/models` → `{base}`。
  填根域名或已带 `/v1` 都能命中；只有 `404` 才换下一个候选。
  - `2xx` → 绿：服务可达且鉴权通过，显示耗时
  - `401/403` → 黄：可达但 Key 不对
  - `404` → 黄：可达但路径可能不匹配
  - 网络错误/超时 → 红：地址错 / 服务未起 / 被拦

### 模型列表自动拉取

`HH.api.fetchModels()` → `GET /v1/models`（OpenAI / New API / One API 通用），返回：

```js
{ ok, models: [{ id, image }], status, latency, message }
```

- 解析兼容 `{data:[]}` / `{models:[]}` / 数组直出；元素可以是字符串或对象。
- 生图判定：`supported_endpoint_types` 含 `image`（New API 才有该字段，没有则视为未知）。
- 排序：生图模型在前，其余按字母序。
- 拉取成功后写入 `api.modelCache`（JSON 字符串，`saveApiSilent` 落盘不重绘），
  智能改图 / AI 生图两页的下拉立即生效。
- 若主模型为空，自动选中第一个生图模型。
- `401/403` 给「Key 无效」、`404` 给「端点不存在」、空列表给「Key 未开通模型」三类独立提示。

- **参数传递链路**（单向，无隐式全局）：

```
mine.js 输入 ──→ store.state.api ──→ api.js cfg()
                                    ├─ buildHeaders(): Authorization: Bearer <key> + 额外头
                                    ├─ url = baseUrl + path
                                    └─ body = buildOpenAIPayload() | buildCustomPayload()
pages/edit.js / generate.js ──→ HH.api.generate() ──→ fetch()
```

模型名解析顺序：`页面下拉值 → api.model → modelCache[0] → modelList[0]`。

---

## ④ 自定义 API 接入约定（无任何商业接口）

### 4.1 默认协议：OpenAI 兼容

```
POST {baseUrl}{path}          path 默认 /v1/images/generations
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "flux-1-schnell",
  "prompt": "把背景换成浅灰水泥墙",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json",
  "image": "data:image/png;base64,..."   // 仅改图/图生图，单图传字符串，多图传数组
}
```

支持解析的返回结构（`api.parseResponse` 已做兼容）：

```jsonc
{ "data": [ { "b64_json": "..." } ] }
{ "data": [ { "url": "https://..." } ] }
{ "images": ["<base64 或 url>"] }
{ "output": [...] } / { "result": [...] } / { "artifacts": [...] }
```

字段名不同 → 改 `parseResponse()` 一处即可。

### 4.2 非标服务：自定义 JSON

「我的 → 请求协议」选 **自定义 JSON**，然后改 `js/api.js` 里的 `buildCustomPayload()`：

```js
function buildCustomPayload(o, c) {
  return {
    model: o.model,
    prompt: o.prompt,
    negative_prompt: o.negative || undefined,
    width:  parseInt(o.size.split('x')[0], 10),
    height: parseInt(o.size.split('x')[1], 10),
    batch_size: o.count,
    init_images: (o.images || []).map(s => s.split(',')[1]),
    // custom_extra: c.someField   ← 自己的参数从 c（API 配置）里取
  };
}
```

这是**唯一需要动的适配点**，UI 层完全不用改。

### 4.3 跨域

CEP 面板默认受 CORS 约束。`CSXS/manifest.xml` 已加：

```xml
<CEFCommandLine>
  <Parameter>--disable-web-security</Parameter>
  <Parameter>--allow-running-insecure-content</Parameter>
  <Parameter>--allow-file-access-from-files</Parameter>
</CEFCommandLine>
```

如果目标服务要求白名单，也可在其网关放开 `Origin: null`（CEP 面板 Origin 为 null）。

### 4.4 未配置时的行为

`baseUrl` 或 `apiKey` 任一为空 → `api.generate()` 直接返回 **mock 图**（Canvas 渐变 + 提示词水印条 + `MOCK 预览` 标注）。目的是让 UI 全流程（生成 → 缩略图 → 历史 → 插入图层）在没接 API 时也能跑通验收。接上真实服务后自动走真实请求，无开关、无需改代码。

---

## 附：安装与调试

1. 把 `extension/` 整个目录拷到：
   `C:\Users\<你>\AppData\Roaming\Adobe\CEP\extensions\com.xy.aistudio.cep\`
2. 开启调试模式（管理员 CMD，各版本都写一遍更稳）：

```bat
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

3. 重启 Photoshop → 菜单 `增效工具 / 窗口 > 扩展功能 > AI Studio`。
4. 调试：Chrome 打开 `http://localhost:8701`，可看 console 与抓包。
5. 不装 PS 也能看 UI：直接双击 `extension/index.html`，浏览器里除「插入图层」外全部可用。

## 已踩过的坑（真机验证）

| 现象 | 根因 | 修法 |
|---|---|---|
| 所有按钮都提示「当前不在 Photoshop CEP 环境中」，但面板明明在 PS 里 | 工程里没有 `CSInterface.js`，`new CSInterface()` 抛错后被当成「无宿主」 | 新增 `js/CSInterface.js`（基于 `window.__adobe_cep__` 的精简实现）；`ps.js` 的 `cs()` 再加一层直连兜底 |
| 点一次「读取选区」得到两张图、弹两条提示 | `bind(root)` 把委托监听挂在常驻的 `#view` 上，每次挂载都叠加一份，一次点击触发多次 | `app.js` 的 `mount()` 改为每次重建 `#view` 节点，旧监听随旧节点回收 |
| `Ctrl+V` 粘一张图变两张 | `document` 级 `paste` 在每次 `bind()` 里重复注册 | 粘贴监听全局只注册一次，绑定时只切换「当前页配置」 |
| 「读取选区」按钮永久卡在「读取中…」 | 还原时用 `btn.innerHTML` 快照，一旦某次异常，快照里存的就是「读取中…」 | 按钮常态文案改为模块常量，还原逻辑用 `then(ok, fail)` 双分支 |
| 插入图层报「无法写入临时文件（cep.fs 与 Node 均不可用）」 | **本机 CEP 12 的 `cep.fs` 没有 `getTempDirectory` 方法**（只有 readFile/writeFile/deleteFile/stat/makedir/showSaveDialogEx…） | 临时目录改为问 ExtendScript：`evalScript('Folder.temp.fsName')`，拿到后缓存 |
| `cep.fs.readFile(path,'UTF8')` 返回 err=5 | 编码常量值其实是 **`'UTF-8'`**（`cep.encoding.UTF8`），不是 `'UTF8'` | 统一用 `cep.encoding.UTF8` |
| `getSystemPath('extension')` 拿到的路径读不到文件 | CEP 12 返回的是 `file:///C:/...` URL | 在 `CSInterface` 垫片里统一转成系统路径（去 `file://`、去 Windows 前导 `/`） |
| 改了 `host.jsx` 但 PS 仍执行旧逻辑 | `<ScriptPath>` 只在扩展首次加载时求值，重载面板不会重跑 | `ps.loadJSX()` 在面板启动时重推 JSX（见 2.6） |
| 点「下载」没反应 | CEP 里 `<a download>` 不触发保存（下载管理器被禁用），且不报错 | 改为 `cep.fs.showSaveDialogEx` 选路径 + `cep.fs.writeFile(Base64)`，取消则静默返回 |
| 下载的图是 `.jpg` 数据但存成了 `.png` / 用户要求统一 png | 接口返回 jpeg，直接改后缀 PS 会判「格式与后缀不符」 | `U.toPng()` 先用 canvas 重新编码，再按 `.png` 写盘，尺寸像素不变 |
| 提示词框里字跑到右边很远，光标也是 | CEF 旧内核偶发把 textarea 的内部横向滚动留在右侧，`scrollLeft > 0` 时新输入的预编辑/上屏文字就画到右侧 | ①`.textarea` 强制 `text-align:left; overflow-x:hidden` ②`input`/`compositionend`/`focus` 里把 `scrollLeft` 按回 0 ③placeholder 缩短到不会溢出的长度 |
| 会话卡片/消息里的图在面板中是空白（`naturalWidth = 0`） | CEP 面板是 `file://` 页面，**加载不了其它 file:// 图片**（加了 `--allow-file-access-from-files` 也一样） | `U.lazyImg(file)` 输出 `data-file` 占位，用 `cep.fs.readFile` 读成 dataURL 回填，按文件名缓存 |
| 另存为对话框「文件名」空着、类型显示 `*.png jpg` | `showSaveDialogEx(title, initialPath, fileTypes, defaultName, friendlyFilePrefix, prompt, nameFieldLabel)` 是 **7 个参数**：`fileTypes` 只放不带点的扩展名数组，`defaultName` 是第 4 个（之前错传成 `false`），类型下拉的说明文字要靠 `friendlyFilePrefix` | 传 `['png'] + '名字.png' + '图片文件 (*.png)'`；扩展名由 `dataURL` 的 mime 推断（`jpeg`→`jpg`），避免 jpg 数据存成 .png |
| 提示词框只能打英文、中文打不上 | 页面层没问题（用 CDP 注入 `Input.imeSetComposition` 验证过，composition 事件链完整、中文能上屏落库）；真正原因是 CEF 面板窗口没挂上 Windows 输入法，另有 `spellcheck` 干扰合成的可能 | ①`spellcheck="false"` ②补 `compositionend` 兜底同步 ③~~`AutoVisible` 改 false~~ **已废弃，见下条** |
| **面板一片灰、只有标题栏**（PS 26 / CEP 12） | 页面本身完全正常：`readyState=complete`、DOM 完整、rAF 60fps、CDP 截图能看到完整 UI。**根因是 manifest 的 `AutoVisible=false`** —— 该值让面板走"启动时不建窗口、之后补建"的路径，而补建出来的 CEF 视图拿不到可见区域。排查中先后误判为 GPU/Vulkan 驱动冲突（RayLink 虚拟显示器）、扩展签名缺失（`META-INF`）、`SetParent` 失败、`parent=0`/`vis=false`，均已推翻 | `AutoVisible` 必须 `true`。不想自动弹出就收起面板让 PS 记住工作区（`Essentials.psw` 中该 panel 的 `is-closed="true"`）。**签名无关**：`CSXS.9`~`CSXS.20` 的 `PlayerDebugMode=1` 已全局开启，未签名扩展照常加载；`window.cep` 只有 `fs/process/encoding/util`，没有关闭面板的 API，不能由页面自行收起 |
| 历史里预览/下载只有 360×360 | 生成时按体积判断：`full: dataUrl.length < 900000 ? dataUrl : thumb`，1024 图必然超过 900KB，于是**把缩略图当原图存了** | 原图写盘 `%APPDATA%/AIStudio/cache`，history 只记 `file`；预览/下载/插入统一走 `HH.ps.resolveImage()`（内存 → 磁盘 → 缩略图） |
| 读回的图片 base64 长度对不上 | `cep.fs.readFile(path,'Base64')` 每 72 字符插一个换行 | 拼 dataURL 前 `replace(/\s+/g,'')` |
| 「插入图层」看不出插的是原图还是缩略图 | `__aiInsertLayer` 只返回插入后的 `bounds`（= 选区尺寸），原图和缩略图铺满同一选区时返回值完全相同；卡片角标又照着 `size` 字段显示 `1024×1024`（那是期望尺寸，不代表还有原图） | ①JSX 多回传一段源图尺寸 `OK:名\|sel\|源图\|插入后` ②`insertTip()` 显示「原图 → 插入后」，放大 >1.05× 升级为警告并标倍数 ③角标按「有无原图来源」显示，无则橙色「仅缩略图」④`imageInfo().lowRes` 前置告警 |
| 老记录的 `full` 本身就是 360 缩略图 | 旧版 `full: dataUrl.length < 900000 ? dataUrl : thumb` 把大图换成了缩略图，写入时就已污染 | `store.fixHistory()` 加载时识别 `full === thumb` → 清空 `full` + 标 `lowRes`；原图不可恢复，提示用户重新生成 |
| 点「选择文件夹」没反应，PS 随后整个卡住 | 用了 ExtendScript 的 `Folder.selectDialog()`：它是**同步模态**调用，跑在 PS 主线程上。对话框的父亲是 PS 主窗口，而 CEP 面板是独立浮窗，对话框常被压在面板后面看不见；同时主线程被锁死，面板、调试端口、菜单全部失去响应 | 主路径换成 **`cep.fs.showOpenDialogEx(false, true, title, start)`** —— 由面板自己的进程弹窗，不经过 PS 主线程。`Folder.selectDialog` 只作为老 CEP 的兜底，并补 `app.bringToFront()` |
| 选择文件夹「点了没反应」，连错误都没有 | `pickDir()` 把「用户取消」和「出错」都返回 `''`，`evalOk` 还 `.catch(() => '')` 把异常吞掉，调用处 `if (!p) return;` 静默返回 | 返回结构化结果 `{ok, path?, cancel?, message?}`：取消不打扰，出错必弹 toast；另加 60 秒超时保护，避免按钮永远转「选择中…」 |
| 系统对话框在某些环境根本弹不出来 | 宿主的原生对话框依赖宿主窗口状态 | 「对话存储位置」下方加一个可直接粘贴路径的输入框 + 「应用」，与对话框走同一套切换/迁移逻辑 |
| **出图 40 秒期间一收起面板就 "Failed to fetch"，钱扣了图没拿到** | 同步模式下整个出图是一个长请求：面板被 » 收起 → CEP 冻结页面 → 这个请求被掐断；而服务端不知情，照跑 43 秒照扣费，结果送不回来 | ①改**异步出图**：`POST` 带 `async: true`，0.5 秒返回 `{id:"task_xxx",status:"queued",progress:"20%"}`；之后 `GET /v1/images/generations/{task_id}` 轮询，`completed` 时取 `data[0].url` ②任务 ID 在**提交那一刻同步写 localStorage**（`js/tasks.js`，同步写才扛得住强杀），面板重开 `resume()` 自动接上并写回原消息 ③每个轮询只有几百毫秒，被掐断无所谓，下一轮接着问 ④消息上加「取回结果」/「复制任务 ID」，「我的」页可按 ID 手动取回 |
| **异步任务的历史拿不回来** | 中转站**没有**"列出任务"的公开端点（`/v1/tasks`、`/v1/usage`、`/v1/logs` 全是 404），只有 `GET .../{task_id}` 单条查询 | 凭 ID 取回：ID 只能来自①提交时本地记录的 ②中转站后台抄的。所以提交即持久化是唯一可靠途径；`/v1/dashboard/billing/usage` 只有 `total_usage` 不给明细 |
| **面板白屏，只剩 CEP 画的标题栏** | DOM 其实是好的（4 个 tab、页面节点都在，`readyState: complete`），坏的是**窗口合成层**：面板被隐藏/收起/重开后，CEF 没有重新合成，画面停在背景色 | ①先确认不是代码问题：用 CDP 截图，能截到完整界面就说明是合成层 ②`Page.bringToFront` + 抖动一次 `setDeviceMetricsOverride` 再 clear，可把画面逼出来 ③**治本**：`js/app.js` 里的 `kickRepaint()` —— 监听 `visibilitychange / focus / pageshow`，在面板重新出现时把 `documentElement` 关掉再打开（同步重排）强制重建渲染层，并用 80/700/1600ms 三次补绘覆盖 CEF 慢恢复；正在输入框里打字时跳过，避免打断中文输入法 ④根因之一是不再调用任何同步系统对话框（见 2.4） |
| `cep.fs.readdir` 列出来的目录判断不了 | CEP 11 返回的是**纯字符串数组**（`['images','sessions','index.json']`），不是文档里写的 `{name, isFile}` 对象；`cep.fs.stat` 也只返回 `mtime`，没有 `isFile / isDirectory` | 只能试读判断：`readdir(子路径).err === 0` 就是目录（文件返回 `err:1`，不存在返回 `err:3`）。`it.isFile` 存在时优先用它，避免不必要的一次 IO |
| 用 `shot.js` 截出来的图看不到半透明遮罩 | `Emulation.setDeviceMetricsOverride` 模式下，`position: fixed` 的 `rgba()` 遮罩不参与合成 | 新增 `tools/shot_raw.js`：不做尺寸覆盖，直接 `Page.captureScreenshot`，截出来就是用户实际看到的画面 |

## 已知边界

- `playload` 里 `image` 字段是行业常见写法，但**不同服务商字段名不一致**（`init_images` / `image_url` / `input_image`），第一次接入大概率要改 `buildCustomPayload`。
- ~~历史里的 `full` 只保留最近 8 条~~（已解决：原图落盘到 `%APPDATA%/AIStudio/cache`，不再受 localStorage 5MB 限制）。**升级前生成的老记录**如果当年 `full` 被换成了缩略图，原图无法找回，卡片上标「仅缩略图」。
- ~~对话记录只留最近 8 段~~（已解决：会话写进 `<dir>/sessions/*.json`，条数只受磁盘限制，上限 300 段；未连接 PS 时才退回 localStorage 的 8 段）。
- 图片记录被删/被清空后，对话记录里的那张图只剩缩略图（`results[].thumb`），插入图层会是缩略图尺寸 —— 此时角标显示橙色「仅缩略图」，插入前会先弹警告。
- **升级前的老记录原图不可找回**：当年写入时 `full` 就被换成了 360 缩略图，磁盘上没有原图文件。要清晰版本只能重新生成。
- 「插入图层」的清晰度取决于源图像素与选区的比例：源图小于选区时必然被放大（提示会标出倍数）。想要最佳效果，让生成尺寸 ≥ 选区尺寸。
- 「插入图层」依赖 `jsx/host.jsx` 的 `__aiInsertLayer`，仅在 CEP 环境可用；浏览器预览会提示不支持。
- **插入按选区铺满 + 裁边**：生成图与选区比例不一致时会遮住多余部分（等比、不变形）。默认是智能对象 + 蒙版，被遮的部分可恢复；关掉智能对象后是硬裁，不可恢复。若想保留完整画面不变形，可改用「无选区」模式（整张画布 contain）。
- **智能对象模式下画笔受限**：这是 PS 本身的行为，不是 bug。拿到图想直接涂抹，到「我的 → 插入图层方式」关掉开关，或插入后右键「栅格化图层」。
- **下载会弹系统「另存为」**：CEP 里没有浏览器下载栏，取消对话框即不保存。
- 历史记录不区分账号，换人用同一台机器会看到同一份记录。
