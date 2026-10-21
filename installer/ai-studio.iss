; ============================================================================
;  AI Studio for Photoshop — CEP 面板安装脚本（Inno Setup 7）
;
;  编译：  ISCC.exe installer\ai-studio.iss
;  产出：  dist\AIStudio-CEP-Setup-<版本>.exe
;
;  ── 设计要点，改之前先读，别删 ──────────────────────────────────────────
;  1. 全程只碰 HKCU + %APPDATA%，所以**不需要管理员、不弹 UAC**。
;     别为了"看起来正规"改成装到 Program Files，那会引入提权，得不偿失。
;  2. CEP 只加载签名过的扩展；未签名的必须开 PlayerDebugMode 才会加载。
;     这个开关是 Adobe 官方留给开发者的，但它是**全局**的 —— 对本机所有
;     未签名扩展生效，不只是我们。所以界面上必须讲清楚在改什么，
;     并且让用户自己勾选。偷偷改注册表是绝对不行的。
;  3. 卸载**只删程序文件**。历史记录、API Key、资料库一律保留 —— 那是用户的
;     数据，安装程序无权处置。要清 Key 请到面板内「我的 → 清除」。
;  4. `.debug` 是开发用的（固定调试端口 8701），不发给最终用户，Excludes 掉了。
;  5. 新装的 CEP 扩展不会热加载，装完**必须重启 PS**。这话得在最后一页说。
; ============================================================================

; 版本号由构建脚本从 manifest.xml 读出来通过 /D 传进来，避免两处不同步
#ifndef MyAppVersion
  #define MyAppVersion "1.2.13"
#endif

#define MyAppName     "AI Studio"
#define MyAppVerName  "AI Studio " + MyAppVersion
#define MyPublisher   "XY"
#define MyExtId       "com.xy.aistudio.cep"
#define MyURL         ""

; 这两项可被 ISCC 的 /D 覆盖 —— 只为了跑测试：
; 测试版用别的 AppId 和别的目录，才不会把真装的插件和卸载项冲掉。
;
; ⚠ AppId 的括号写法是 Inno 的坑：GUID 要写成 **左双右单** —— 左边两个左花括号、
;   右边一个右花括号。写成左右都双的话，卸载项 key 会多出一个右括号，
;   于是"卸载项已登记"这类断言永远对不上。
#ifndef MyAppId
  #define MyAppId "{{9516E6C1-B7D5-404D-A5F7-1D0610972BF4}"
#endif
#ifndef MyDestName
  #define MyDestName "com.xy.aistudio.cep"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppVerName}
AppPublisher={#MyPublisher}
AppPublisherURL={#MyURL}
AppSupportURL={#MyURL}
AppUpdatesURL={#MyURL}
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription={#MyAppVerName} 安装程序

; 装到用户级 CEP 目录。DisableDirPage 让用户改不了 —— 改了 PS 就找不到。
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#MyDestName}
DisableDirPage=yes
DisableProgramGroupPage=yes
AllowNoIcons=yes

; 关键：不请求管理员。整个安装都在用户可写范围内。
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; 关键：不加这行，安装器跑在 32 位模式 —— {pf} 会解析成 "Program Files (x86)"。
; 而 Photoshop 装在 "Program Files"，于是 ScanFolder 扫了个空目录；
; 同时 HKLM 会被重定向到 WOW6432Node，那里的 Adobe\Photoshop 根本不存在。
; 实测（tools\_probe\probe.iss）：不加 → {pf}="C:\Program Files (x86)"；
; 加了 → {pf}="C:\Program Files"，注册表和目录两条路都能命中。
; 32 位系统上会自动回退到 32 位模式，不影响老机器。
ArchitecturesInstallIn64BitMode=x64compatible

; 不要试图替用户关 PS（会丢未保存的活），只在最后一页提示重启
CloseApplications=no
RestartApplications=no

WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=AIStudio-CEP-Setup-{#MyAppVersion}
; 已存在同名目录时不警告 —— 覆盖升级是正常场景
DirExistsWarning=no
UsePreviousAppDir=no

UninstallDisplayName={#MyAppVerName}（Photoshop 面板）
; 卸载程序也不要管理员权限 —— 它删的都是用户自己目录下的东西
Uninstallable=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

; 中英混排的说明文字直接写在 Code 里，不依赖语言包
[CustomMessages]
chinesesimplified.DataKeptOnUninstall=数据已保留

[Files]
Source: "..\extension\*"; DestDir: "{app}"; \
    Excludes: ".debug,*.bak,Thumbs.db"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; ============================================================================
;  注册表：CEP 的未签名加载开关
;  —— 不写在 [Registry] 段，因为要先取得用户同意，所以放到 Code 里手动写。
; ============================================================================

; 「是否开启未签名扩展加载」做成 Task 而不是自定义复选框，
; 因为 Task 是 Inno 原生的：静默安装时能用 /TASKS= 精确控制，
; 而自定义页的状态在静默模式下根本没法从外部改（param 常量读不到、
; GetCmdTail 是内部串、环境变量实测也进不来）。测不了 = 守不住。
[Tasks]
Name: "debugmode"; \
    Description: "开启 Photoshop 未签名扩展加载（不勾的话插件装了也不会出现）"; \
    Flags: checkedonce

[Code]

const
  { 换行符。必须写成常量而不是到处写 #13#10：
    ISPP 会把**行首**的 # 当成预处理指令，续行后正好落在行首就会编译失败。 }
  NL = #13#10;

var
  PSVer:   array of String;     { 检测到的 PS 版本，如 "26.0" }
  PSPath:  array of String;     { Photoshop.exe 全路径 }
  PSCount: Integer;

  PSInfoPage:  TOutputMsgMemoWizardPage;
  ExplainPage: TOutputMsgMemoWizardPage;

{ ---------- PS 探测 ---------- }

procedure AddPS(const Ver, Path: String);
begin
  SetLength(PSVer,  PSCount + 1);
  SetLength(PSPath, PSCount + 1);
  PSVer[PSCount]  := Ver;
  PSPath[PSCount] := Path;
  PSCount := PSCount + 1;
end;

function AlreadyHas(const P: String): Boolean;
var I: Integer;
begin
  Result := False;
  for I := 0 to PSCount - 1 do
    if Lowercase(PSPath[I]) = Lowercase(P) then begin
      Result := True;
      Exit;
    end;
end;

{ 一个注册表根下扫 Photoshop 子键：每个子键是一个版本号，里面有 ApplicationPath }
procedure ScanRegRoot(const RootKey: Integer);
var
  Subs: TArrayOfString;
  I: Integer;
  AP: String;
begin
  if not RegGetSubkeyNames(RootKey, 'SOFTWARE\Adobe\Photoshop', Subs) then Exit;
  for I := 0 to GetArrayLength(Subs) - 1 do begin
    AP := '';
    if RegQueryStringValue(RootKey, 'SOFTWARE\Adobe\Photoshop\' + Subs[I],
                           'ApplicationPath', AP) then begin
      if AP = '' then Continue;
      if Copy(AP, Length(AP), 1) <> '\' then AP := AP + '\';
      if FileExists(AP + 'Photoshop.exe') and (not AlreadyHas(AP + 'Photoshop.exe')) then
        AddPS(Subs[I], AP + 'Photoshop.exe');
    end;
  end;
end;

{ 从安装目录名里抠年份："C:\...\Adobe Photoshop 2025" → "2025"
  注册表里 PS 2025 的版本子键是 190.0（内部 build 号），对用户毫无意义，
  而目录名里有可读的年份，所以优先用目录名。 }
function VerFromPath(const Dir: String): String;
var
  S: String;
  I: Integer;
begin
  S := ExtractFileName(RemoveBackslashUnlessRoot(Dir));
  I := Length(S);
  while (I > 0) and (S[I] >= '0') and (S[I] <= '9') do Dec(I);
  Result := Copy(S, I + 1, Length(S) - I);
  if Result = '' then Result := '未知';
end;

{ 兜底：直接扫安装目录。注册表没记录时（绿色版/重装残留）还能找到。 }
procedure ScanFolder(const Base: String);
var
  FindRec: TFindRec;
  Sub: String;
begin
  if not DirExists(Base) then Exit;
  { 注意：Inno 的 FindRec.Name 只给**最后一段名字**，不给相对路径。
    所以不能直接拿 "Adobe Photoshop*\Photoshop.exe" 去扫再把 Name 拼上去 ——
    那样拼出来是 "...\Adobe\Photoshop.exe"，路径是错的。必须分两步：
    先找目录，再自己拼 "\Photoshop.exe" 验证。 }
  if FindFirst(Base + '\Adobe Photoshop*', FindRec) then begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin
          Sub := Base + '\' + FindRec.Name;
          if FileExists(Sub + '\Photoshop.exe') and
             (not AlreadyHas(Sub + '\Photoshop.exe')) then
            AddPS(VerFromPath(Sub), Sub + '\Photoshop.exe');
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

procedure DetectPhotoshop;
var I: Integer;
begin
  PSCount := 0;
  { 64 位和 32 位注册表视图都扫：万一安装器落在 32 位模式，
    不显式指定 HKLM64 就会被重定向到 WOW6432Node，而现在的 PS 全是 64 位的 }
  ScanRegRoot(HKLM64);
  ScanRegRoot(HKLM32);
  ScanRegRoot(HKEY_LOCAL_MACHINE);

  ScanFolder(ExpandConstant('{pf}\Adobe'));
  ScanFolder(ExpandConstant('{pf32}\Adobe'));

  { 全部打到安装日志里。没有这行，"为什么没找到 PS" 只能靠猜 ——
    之前就是探测函数压根没被调用，而界面上看上去像"扫描过了没找到"。 }
  Log('PS 探测结果：' + IntToStr(PSCount) + ' 个');
  for I := 0 to PSCount - 1 do
    Log('  [' + PSVer[I] + '] ' + PSPath[I]);
end;

{ 主版本号 → 这条 PS 用哪个 CEP 版本
  21.x=2020→CEP9  22.x=2021→CEP10  23/24/25.x=2022~2024→CEP11  26.x+→CEP12 }
function MajorOf(const Ver: String): Integer;
var P: Integer;
begin
  P := Pos('.', Ver);
  if P = 0 then P := Length(Ver) + 1;
  Result := StrToIntDef(Copy(Ver, 1, P - 1), 0);
end;

function SupportedByManifest(const Ver: String): Boolean;
begin
  { manifest.xml 里 Host Version="[23.0,99.9]" —— PS 2022 起 }
  Result := (Ver = '未知') or (MajorOf(Ver) >= 23);
end;

{ 给用户看的名字。注册表版本 190.0 是内部 build 号，摆出来没人看得懂，
  所以优先用目录名里的年份，两个不同就并排显示。 }
function LabelOf(const Ver, Path: String): String;
var Y: String;
begin
  Y := VerFromPath(ExtractFileDir(Path));
  if (Y <> '未知') and (Y <> Ver) then
    Result := 'Photoshop ' + Y + '（注册表版本 ' + Ver + '）'
  else if Y <> '未知' then
    Result := 'Photoshop ' + Y
  else
    Result := '版本 ' + Ver;
end;

function BuildPSReport: String;
var I: Integer;
begin
  Result := '';
  if PSCount = 0 then begin
    Result := '没在这台机器上找到 Photoshop。' + NL +
              NL +
              '仍然可以继续装 —— 面板文件会先放到你的用户目录里，' + NL +
              '等你装好 Photoshop 之后，面板就会出现在「窗口 > 扩展功能」里。' + NL +
              NL +
              '注意：这个插件需要 Photoshop 2022（23.0）或更高版本。';
    Exit;
  end;

  Result := '在这台机器上找到 ' + IntToStr(PSCount) + ' 个 Photoshop：' + NL + NL;
  for I := 0 to PSCount - 1 do begin
    Result := Result + '  · ' + LabelOf(PSVer[I], PSPath[I]) + NL + '    ' + PSPath[I] + NL;
    if SupportedByManifest(PSVer[I]) then
      Result := Result + '    受支持' + NL
    else
      Result := Result + '    ⚠ 版本过低，需要 Photoshop 2022（23.0）或更高' + NL;
    if I < PSCount - 1 then Result := Result + NL;
  end;
end;

{ ---------- 向导页 ---------- }

procedure InitializeWizard;
begin
  { 必须先探测再建页：BuildPSReport 读的是 PSCount/PSVer/PSPath。
    ⚠ 这一行曾经漏掉过 —— 探测函数写好了却没人调用，界面永远显示
      "没在这台机器上找到 Photoshop"。加功能时别只看函数在不在，
      要确认它有没有被接线。 }
  DetectPhotoshop;

  { 把用户将要在第一页看到的那段话也写进日志 —— 出问题时能直接对上
    用户截图里显示的内容，不用猜界面渲染成了什么 }
  Log('PS 报告预览：' + NL + BuildPSReport);

  { 第一页：把探测结果原样摆出来，别藏在日志里 }
  PSInfoPage := CreateOutputMsgMemoPage(wpWelcome,
    'Photoshop 检测',
    '安装前先看看你这台机器上有什么',
    '下面是从注册表和安装目录里扫出来的结果：',
    '');

  { 第二页：纯说明。插在任务页**之前**，所以是 wpSelectTasks。
    真正的开关放 [Tasks]，因为 Task 能用 /TASKS= 从命令行控制，静默安装也能测。 }
  ExplainPage := CreateOutputMsgMemoPage(wpSelectTasks,
    '需要开启 Photoshop 的「未签名扩展」开关',
    '这一步不是可选的装饰，是插件能不能加载的前提',
    'Photoshop 出于安全考虑，默认只加载**签名过**的扩展。' + NL +
    '本插件没有购买 Adobe 的代码签名证书，所以必须打开官方留给开发者的开关：' + NL +
    NL +
    '    注册表 HKCU\Software\Adobe\CSXS.<版本>\PlayerDebugMode = 1' + NL +
    NL +
    '要清楚三件事：' + NL +
    '  1. 它只改动你自己的账户（HKCU），不影响别的 Windows 用户；' + NL +
    '  2. 它是**全局**的 —— 会同时允许本机其他未签名扩展加载，不只是本插件；' + NL +
    '  3. 卸载时本程序不会把它改回去（别的扩展可能正在用它），' + NL +
    '     想恢复可以自己把这几项删掉。' + NL +
    NL +
    '下一页的复选框默认勾着。取消勾选的话，插件文件会照常装好，' + NL +
    '但 Photoshop 不会加载它 —— 面板根本不会出现。',
    '');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PSInfoPage.ID then
    PSInfoPage.RichEditViewer.RTFText := BuildPSReport;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  { 用户明确不勾选 → 明确告诉他后果，别让他装完一脸茫然。
    静默安装时绝不能弹：弹了没人点，安装就永远卡在这一页（踩过）。 }
  if (CurPageID = wpSelectTasks) and (not WizardIsTaskSelected('debugmode'))
     and (not WizardSilent) then begin
    Result := MsgBox('你没有勾选「开启未签名扩展加载」。' + NL + NL +
                     '这样装完之后 Photoshop 不会加载本插件，' +
                     '到「窗口 > 扩展功能」里是找不到 AI Studio 的。' + NL + NL +
                     '确定要继续吗？',
                     mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  end;
end;

{ ---------- 收尾：把"必须重启 PS"讲明白 ---------- }

function FinishMessage: String;
begin
  Result := 'AI Studio 面板已安装到：' + NL +
            '  ' + ExpandConstant('{app}') + NL + NL;

  if WizardIsTaskSelected('debugmode') then
    Result := Result + '未签名扩展加载：已开启' + NL + NL
  else
    Result := Result + '未签名扩展加载：未开启（Photoshop 不会加载本插件）' + NL + NL;

  Result := Result +
    '接下来必须做一件事：' + NL + NL +
    '  1. 如果 Photoshop 正在运行，请**完全退出再重新打开**。' + NL +
    '     新装的扩展不会热加载，这一步不能省。' + NL +
    '  2. 打开 Photoshop 后到「窗口 > 扩展功能」里点 AI Studio。' + NL + NL +
    '首次使用还需要到面板「我的」页填一次 API Key —— ' +
    '安装程序不收集也不预置任何密钥。';
end;

procedure ShowFinishMessage;
begin
  { 完成页的文字是静态 label，塞不进动态内容（路径、开关状态），
    所以在这里直接用弹窗把话说完。静默安装时不能弹。 }
  if not WizardSilent then
    MsgBox(FinishMessage, mbInformation, MB_OK);
end;

{ ---------- 安装后写注册表 ---------- }

procedure WriteDebugMode;
var
  I: Integer;
  Key: String;
  N: Integer;
begin
  { 覆盖 CEP 9 ~ 20。多写几个空键没有副作用，漏写一个就是"装完不出现"。
    实测开发机上 CSXS.9 ~ CSXS.20 本来就是全开的。 }
  N := 0;
  for I := 9 to 20 do begin
    Key := 'Software\Adobe\CSXS.' + IntToStr(I);
    if RegWriteDWordValue(HKEY_CURRENT_USER, Key, 'PlayerDebugMode', 1) then
      N := N + 1;
  end;
  Log('PlayerDebugMode 已写入 ' + IntToStr(N) + ' 个 CSXS 键');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if WizardIsTaskSelected('debugmode') then
      WriteDebugMode
    else
      Log('未开启 debugmode 任务，跳过注册表写入');
  end;
  if CurStep = ssDone then
    ShowFinishMessage;
end;


{ ---------- 卸载：只删程序，绝不碰数据 ---------- }

function InitializeUninstall: Boolean;
begin
  { 静默卸载时不能弹框 —— 弹了会返回默认按钮（"否"），等于卸载永远取消。 }
  if UninstallSilent then begin
    Result := True;
    Exit;
  end;
  Result := MsgBox('即将卸载 AI Studio 面板。' + NL + NL +
                   '你的数据（历史记录、API Key、资料库文件夹）会**全部保留**，' + NL +
                   '本程序不会删除它们。' + NL + NL +
                   '继续卸载吗？',
                   mbConfirmation, MB_YESNO) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then begin
    MsgBox('已卸载 AI Studio 面板。' + NL + NL +
           '以下内容已保留，需要的话请自行处理：' + NL +
           '  · 资料库目录（生成的图和对话）—— 在面板「我的 → 存储位置」看过路径' + NL +
           '  · API Key 与模型配置 —— 面板「我的」页可一键清除' + NL + NL +
           'Photoshop 正在运行的话，重启后「扩展功能」里就不再有 AI Studio 了。',
           mbInformation, MB_OK);
  end;
end;
