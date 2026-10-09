# 未央观察站

一个带本地持久化登录后台的活动积分监测器。直接打开 `index.html` 可以体验界面；要抓取真实未央雨课堂数据，请按下面的后台步骤运行。


## 首次运行真实监测

推荐直接运行一键脚本：双击 `run-monitor.cmd`，或者在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-monitor.ps1
```

脚本会自动完成依赖检查、Playwright Chromium 安装、首次登录和后台启动。已经登录过的情况下会直接复用会话；需要切换账号时执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-monitor.ps1 -Relogin
```

也可以手动执行下面的完整流程：

在 PowerShell 中进入项目目录后执行：

```powershell
npm install
npm run install-browser
npm run login
npm start
```

需要自定义 Chromium 安装位置时，先在项目目录打开 PowerShell。执行顺序是：先安装 npm 依赖，再设置路径，然后安装 Chromium，最后登录并启动监测。路径必须在 `npm run install-browser` **之前**设置；下面这些命令要在同一个 PowerShell 窗口中依次执行：

```powershell
npm install
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\PlaywrightBrowsers'
npm run install-browser
npm run login
npm start
```

如果使用 `run-monitor.cmd` 自动安装，先在 PowerShell 设置变量，再从**同一个窗口**运行脚本；直接双击启动器时，应先把变量保存为 Windows 用户环境变量，再重新登录 Windows 或打开新的终端。例如：

```powershell
[Environment]::SetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', 'D:\PlaywrightBrowsers', 'User')
```

Chrome/Edge 的 CDP 后台适配连接系统中已安装的浏览器，此路径主要用于 Playwright 管理的 Chromium。

`npm run login` 会打开一个可见的 Chromium 窗口。请在窗口中完成未央雨课堂登录，回到终端按 Enter 保存会话。之后 `npm start` 会在后台定时扫描，并在 <http://127.0.0.1:8787/> 提供面板。

复制 `monitor.config.example.json` 为 `monitor.config.json` 后，可以按实际页面 DOM 调整活动卡片、标题、板块、活动类型、积分、积分进度和个人主页信息的选择器。数据源地址固定为 <https://weiyang.yuketang.cn/pro/portal/home/>，配置文件不能改成其他数据源。由于未央雨课堂可能按账号、版本返回不同页面结构，选择器是可配置的；登录态失效时后台状态会变为“需要重新登录”，重新运行 `npm run login` 即可。

## Windows 开机自启

先让后台正常运行过一次（确认登录态和监测都正常），然后执行一次：

```powershell
node tools\install-autostart.js
```

这会在当前用户的启动目录创建快捷方式 `未央观察站.lnk`，不需要管理员权限。开机后在后台监测，**不打开**雨课堂网站、监测网页，也**不会出现任何窗口**；桌面通知仍会按设置弹出。


**关掉开机自启**（同样不需要管理员权限）：

```powershell
node tools\install-autostart.js --remove
```

也可以手动删：`Win+R` 输入 `shell:startup`，把里面的 `未央观察站.lnk` 删掉即可。

**查看自启状态**：

```powershell
node tools\install-autostart.js --check
```

安装脚本会在安装前检查两个脚本的编码，安装后用 Windows 自己的接口读回快捷方式，打印目标、参数、工作目录以及这几个路径是否真实存在。


未连接后台或抓取失败时，会显示“等待主页数据”。后台会从未央雨课堂的活动报名列表抓取活动卡片，再回到个人主页读取个人信息；所有展示内容均来自未央雨课堂页面。

活动报名页实际提供了活动名称、开班时间、人数、分类标签、简介和报名状态。积分只有在活动卡片或简介中明确出现时才会显示；页面没有提供的字段保持为空，不会推测或补造。

## 目录结构

```
根目录         入口：run-monitor.cmd、start-autostart.vbs / .cmd、README.md、package.json，以及面板静态文件
  src/         后台本体（server.js）
  scripts/     运行脚本（PowerShell / cmd）
  launchers/   Windows 启动器（vbs，手动双击走这里）
  assets/      图标位图资源
  tools/       构建、安装与校验脚本（不参与运行）
```

**入口就一个**：双击根目录的 `run-monitor.cmd`，或执行 `npm start`。`start-autostart.vbs` / `start-autostart.cmd` 是开机自启用的，平时不用管（`start-autostart.vbs` 直接双击没反应是正常的，它是给 wscript 调用的）。其余目录都不用管。

脚本之间靠「自身所在目录」互相定位（`$PSScriptRoot`、`WScript.ScriptFullName`、`path.join(ROOT, ...)`），所以移动目录时每一处引用都要同步改基准——各脚本里凡是跨目录引用都写了注释说明。

<details>
<summary><b>每个文件做什么（点开）</b></summary>

| 位置 | 内容 | 作用 |
| --- | --- | --- |
| 根目录 | `index.html`、`app.js`、`styles.css`、`icon-assets.js`、`sheep-icon.js` | 本地面板（`icon-assets.js` 内嵌了图标位图）。这几个必须同级，由后台按静态文件直接提供 |
| 根目录 | `run-monitor.cmd` | 一键启动入口 |
| 根目录 | `start-autostart.vbs` | 开机自启的隐藏入口（快捷方式指向 `wscript.exe` 时的参数）。**必须留在项目根**。作用只是以隐藏方式调用下面的批处理，本身不做事；纯 ASCII，因为 WSH 按 ANSI 读 `.vbs` |
| 根目录 | `start-autostart.cmd` | 开机自启实际干活儿的部分。靠 `%~dp0` 定位项目根，探测 8787 是否已在跑，没跑就启动 `src\server.js`，每一步写 `startup.log`。纯 ASCII，因为 cmd 按 ANSI 解析 `.cmd` |
| 根目录 | `monitor.config.example.json` | 选择器配置模板（复制为 `monitor.config.json` 后修改，该文件不会被提交） |
| `src/` | `server.js` | 后台：抓取、定时扫描、状态接口、桌面通知。它的 `ROOT` 指向项目根，因为配置、登录态、`logs/` 都在那边 |
| `scripts/` | `run-monitor.ps1`、`run-connected-monitor.ps1`、`start-monitor.ps1` | 启动与依赖检查（会在项目根执行 `npm start`） |
| `scripts/` | `start-edge-monitor.ps1`、`wrap-npm-start.ps1` | 以调试模式启动 Edge/Chrome，并把 `npm start` 的输出记入 `logs/server.log` |
| `scripts/` | `log-startup-event.ps1` | 早期的自启审计日志。自启已改由根目录 `start-autostart.cmd` 直接写 `startup.log`（`cmd` 的 `echo >>` 不会静默失败），这个脚本现在没有调用方 |
| `scripts/` | `windows-notify.ps1` | Windows 桌面提醒窗口（轨迹日志在 `logs/notify-trace.log`） |
| `scripts/` | `test-live-notification.ps1` | 通知自检 |
| `launchers/` | `launch-monitor.vbs` | 手动双击启动（隐藏窗口调用 `scripts/start-edge-monitor.ps1`）。注意它内部的 PowerShell 日志调用在本机静默失败，所以不再用于开机自启 |
| `launchers/` | `launch-monitor-ui.vbs`、`launch-chrome-*.vbs` | 带界面启动、Chrome 版本的启动器 |
| `launchers/` | `setup-desktop.vbs`、`setup-chrome-startup.vbs` | 创建桌面 / 启动文件夹快捷方式（自启请改用 `tools\install-autostart.js`） |
| `launchers/` | `windows-notify.vbs`、`windows-dialog.vbs` | 通知窗口的历史入口，当前无代码调用（保留兼容） |
| `launchers/` | `test-desktop-notification.vbs` | 通知自检（双击即用） |

**编码注意**：`launchers/` 下的 `.vbs` 含中文的必须是 **UTF-16LE + BOM**。实测 WSH 只认这一种——UTF-8（带不带 BOM 都）会直接解析失败。`launch-monitor.vbs` 是纯 ASCII 文件，中文用 `ChrW()` 转义承载，这样不依赖代码页。同理，`.cmd` 必须是纯 ASCII 或写成 **GBK**：`cmd.exe` 按 ANSI 代码页解析 `.cmd`，UTF-8 写的中文注释会让解析器把行粘在一起。

### tools/ 里的脚本

这些都不参与运行，只在你需要重新生成资源、装自启或发布时用。**都在项目根目录下执行**：

```powershell
node .\tools\build-icon-assets.js          # 由原始线稿重新生成图标资源
node .\tools\build-release-zip.js          # 打出发布用的 weiyang-monitor-github.zip
node .\tools\check-icons.js                # 核对图标渲染（尺寸、着色、是否残留破图）
node .\tools\check-file-lists.js           # 核对打包与发布两份文件清单一致、且文件都在
node .\tools\fix-ps1-encoding.js           # 给含中文的 .ps1 补 UTF-8 BOM（编辑后跑一次）
node .\tools\install-autostart.js          # 安装开机自启（--remove 关闭，--check 查看状态）
```

`build-icon-assets.js` 从手绘的蓝色线稿生成图标：裁掉四周留白 → 白底转透明 → 缩到 128px → 内嵌成 data URL 写入 `icon-assets.js`，中间产物存到 `assets/`。要换图就改脚本顶部的 `ICONS` 表。抠图有两种模式：`chroma`（按色度，适合内部有白色填充的插画）和 `luminance`（按亮度，适合纯线条图标）。

图标着色由 `index.html` 里的 `#sheepTint` 滤镜完成，它把图里的蓝色映射成界面配色。注意该滤镜的输出色是**常量而非 `currentColor`**，所以位图图标跟不上高亮状态变色——需要跟随状态变色时（例如侧边栏当前项）要用矢量图标。

`tools/publish-to-github.js` 用 GitHub API 把源码推成一次提交并把 zip 挂到 Release 上，token 从环境变量读：

```powershell
$env:GH_TOKEN = '<你的 token>'
node .\tools\publish-to-github.js Polucky717/weiyang-monitor v1.0.0
```

</details>


## 复用已经登录的 Edge

如果你已经在 Edge 中登录了未央雨课堂，使用下面的方式让监测器复用该登录态：

1. 保存工作并完全退出所有 Edge 窗口。
2. 在项目目录执行 `powershell -ExecutionPolicy Bypass -File .\scripts\start-edge-monitor.ps1`。脚本会优先复制 `Profile 1`；如果你的登录账号在其他配置中，可加参数，例如 `-ProfileDirectory Default`。
3. 脚本把配置复制到监测器专用目录（原 Edge 配置保持不变），再以远程调试模式启动 Edge 和监测后台。

这个流程不会读取或保存密码，只复制 Edge 已保存的登录态。首次复制后，新实例中的后续登录状态会保存在监测器专用目录。如果你刚在原 Edge 重新登录，需要用 `-RefreshProfile` 更新副本。脚本连接的是 `https://weiyang.yuketang.cn/pro/portal/home/`，不会从其他页面补造数据。

监测网页现在使用独立的 Edge 配置打开，关闭 `http://127.0.0.1:8787/` 只会关闭界面，不会关闭后台使用的登录会话或停止扫描。后台仍通过监测器专用 Edge 调试实例持续抓取数据。

如果 Edge 调试实例已经启动，只需要重启后台代码即可：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-connected-monitor.ps1
```

## 使用 Chrome

Chrome 适配与 Edge 使用同一套监测后台，但登录会话保存在独立的 Chrome 监测配置中。首次设置时：

1. 安装 Google Chrome，并完全退出所有 Chrome 窗口。
2. 双击 `launchers\launch-chrome-login.vbs`。Chrome 会打开未央雨课堂，完成登录后关闭该 Chrome 窗口。
3. 双击 `launchers\launch-chrome-monitor.vbs` 启动 Chrome 无头后台监测；它不会打开雨课堂页面或本地监测网页，也不会显示 PowerShell 窗口。

Chrome 默认使用调试端口 `9223`，登录配置保存在 `%LOCALAPPDATA%\WeiyangMonitor\ChromeDebugData`。Edge 继续使用 `9222` 和自己的配置。需要改回 Edge 时，使用 `launchers\launch-monitor.vbs`。如果 Chrome 会话过期，再运行 `launchers\launch-chrome-login.vbs` 登录。
