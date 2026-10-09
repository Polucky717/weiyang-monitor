param(
  [switch]$Relogin,
  [switch]$InstallStartup,
  [switch]$SkipBrowserInstall
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
# 切到项目根：npm 需要 package.json，node_modules 也在那边。
Set-Location -LiteralPath $ProjectRoot

function Invoke-Step([string]$Command, [string[]]$Arguments) {
  Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败（退出码 $LASTEXITCODE）：$Command $($Arguments -join ' ')"
  }
}

 $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCommand) { $npmCommand = (Get-Command npm.exe -ErrorAction SilentlyContinue).Source }
if (-not $npmCommand) {
  throw '没有找到 npm。请先安装 Node.js LTS：https://nodejs.org/'
}

Write-Host '未央观察站启动器' -ForegroundColor Green
Write-Host "项目目录：$ProjectRoot"

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\playwright'))) {
  Invoke-Step $npmCommand @('install')
}

if (-not $SkipBrowserInstall) {
  $browserCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
  $chromiumInstalled = Test-Path (Join-Path $browserCache 'chromium-*')
  if (-not $chromiumInstalled) {
    Invoke-Step $npmCommand @('run', 'install-browser')
  }
}

$loginMarker = Join-Path $ProjectRoot '.weiyang-login-complete'
if ($Relogin -or -not (Test-Path -LiteralPath $loginMarker)) {
  Write-Host "`n首次运行需要登录未央雨课堂。浏览器打开后完成登录，再回到此窗口按 Enter。" -ForegroundColor Yellow
  Invoke-Step $npmCommand @('run', 'login')
}

if ($InstallStartup) {
  Invoke-Step 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'install-startup.ps1'))
}

Write-Host "`n后台即将启动：http://127.0.0.1:8787/" -ForegroundColor Green
Invoke-Step $npmCommand @('start')
