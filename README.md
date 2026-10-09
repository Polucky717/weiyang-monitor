# 未央观察站

一个带本地持久化登录后台的活动积分监测器。直接打开 `index.html` 可以体验界面；要抓取真实未央雨课堂数据，请按下面的后台步骤运行。


## 首次运行真实监测

推荐直接运行一键脚本：双击 `run-monitor.cmd`，或者在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-monitor.ps1
```

脚本会自动完成依赖检查、Playwright Chromium 安装、首次登录和后台启动。已经登录过的情况下会直接复用会话；需要切换账号时执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-monitor.ps1 -Relogin
```

首次启动时可以同时配置开机自启：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-monitor.ps1 -InstallStartup
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

如果不想手动打开 PowerShell，双击项目目录中的 `setup-desktop.vbs` 一次。它只会加入当前用户的开机启动，不创建桌面快捷方式；开机后使用无头 Edge 在后台监测，不打开雨课堂网站、监测网页或 PowerShell 窗口。Windows 桌面通知仍会按设置弹出。

后台运行稳定后执行一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-startup.ps1
```

这会在当前用户的启动目录创建后台启动项，不需要管理员权限。开机时通过隐藏启动器运行无头 Edge 和监测后台，不打开 Windows Terminal、PowerShell 窗口、雨课堂网站或监测网页。浏览器会优先复用 `%LOCALAPPDATA%\WeiyangMonitor\browser-profile` 会话目录；如果系统限制该目录，会自动回退到临时目录。

页面不再内置活动、积分或个人信息演示数据。未连接后台或抓取失败时会显示“等待主页数据”。后台会从未央雨课堂的活动报名列表抓取活动卡片，再回到个人主页读取个人信息；所有展示内容均来自未央雨课堂页面。

活动报名页实际提供了活动名称、开班时间、人数、分类标签、简介和报名状态。积分只有在活动卡片或简介中明确出现时才会显示；页面没有提供的字段保持为空，不会推测或补造。


## 复用已经登录的 Edge

如果你已经在 Edge 中登录了未央雨课堂，使用下面的方式让监测器复用该登录态：

1. 保存工作并完全退出所有 Edge 窗口。
2. 在项目目录执行 `powershell -ExecutionPolicy Bypass -File .\start-edge-monitor.ps1`。脚本会优先复制 `Profile 1`；如果你的登录账号在其他配置中，可加参数，例如 `-ProfileDirectory Default`。
3. 脚本把配置复制到监测器专用目录（原 Edge 配置保持不变），再以远程调试模式启动 Edge 和监测后台。

这个流程不会读取或保存密码，只复制 Edge 已保存的登录态。首次复制后，新实例中的后续登录状态会保存在监测器专用目录。如果你刚在原 Edge 重新登录，需要用 `-RefreshProfile` 更新副本。脚本连接的是 `https://weiyang.yuketang.cn/pro/portal/home/`，不会从其他页面补造数据。

监测网页现在使用独立的 Edge 配置打开，关闭 `http://127.0.0.1:8787/` 只会关闭界面，不会关闭后台使用的登录会话或停止扫描。后台仍通过监测器专用 Edge 调试实例持续抓取数据。

如果 Edge 调试实例已经启动，只需要重启后台代码即可：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-connected-monitor.ps1
```

## 使用 Chrome

Chrome 适配与 Edge 使用同一套监测后台，但登录会话保存在独立的 Chrome 监测配置中。首次设置时：

1. 安装 Google Chrome，并完全退出所有 Chrome 窗口。
2. 双击 `launch-chrome-login.vbs`。Chrome 会打开未央雨课堂，完成登录后关闭该 Chrome 窗口。
3. 双击 `launch-chrome-monitor.vbs` 启动 Chrome 无头后台监测；它不会打开雨课堂页面或本地监测网页，也不会显示 PowerShell 窗口。

Chrome 默认使用调试端口 `9223`，登录配置保存在 `%LOCALAPPDATA%\WeiyangMonitor\ChromeDebugData`。Edge 继续使用 `9222` 和自己的配置。需要改回 Edge 时，使用 `launch-monitor.vbs`。如果 Chrome 会话过期，再运行 `launch-chrome-login.vbs` 登录。
