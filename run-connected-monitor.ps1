param([int]$Port = 9222)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
if (-not $version.webSocketDebuggerUrl) { throw "Edge 调试端口 $Port 不可用。请先运行 start-edge-monitor.ps1。" }
$env:WEIYANG_CDP_URL = "http://127.0.0.1:$Port"
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw '没有找到 npm.cmd。' }
$backendReady = $false
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/state' -TimeoutSec 2
  $backendReady = $true
} catch { }
if ($backendReady) {
  Write-Host '监测后台已经在 127.0.0.1:8787 运行，本次直接复用，不重复启动。' -ForegroundColor Yellow
  exit 0
}
& $npm start
