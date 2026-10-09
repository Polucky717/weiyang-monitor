<#
  Edge / Chrome monitor launcher.

  This file is deliberately pure ASCII. Windows PowerShell 5.1 (the engine the
  Startup shortcut launches through wscript) decodes a BOM-less .ps1 using the
  system ANSI code page, which turns embedded Chinese into mojibake and breaks
  parsing ("unexpected token }" / "string missing terminator"). Keeping the
  launcher ASCII removes that failure mode entirely, so auto-start cannot break
  because of an editor or tool rewriting the file.

  NOTE: do not add non-ASCII characters here, and do not "fix" the encoding by
  adding a BOM - a BOM alone is lost again the moment an editor rewrites the
  file.
#>
param(
  [ValidateSet('Edge', 'Chrome')][string]$Browser = 'Edge',
  [int]$Port = 0,
  [string]$ProfileDirectory = '',
  [switch]$RefreshProfile,
  [switch]$NoDashboard,
  [switch]$LoginOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Startup-chain log: appends to startup.log in the project root so a given day's
# auto-start can be audited afterwards. The logger is intentionally failure-proof
# and this wrapper swallows its errors, so logging can never block startup.
function Write-StartupEvent {
  param([string]$Event, [string]$Detail = '')
  try {
    $logger = Join-Path $PSScriptRoot 'log-startup-event.ps1'
    if (Test-Path -LiteralPath $logger) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $logger -Event $Event -Detail $Detail | Out-Null
    }
  } catch { }
}

$homeUrl = 'https://weiyang.yuketang.cn/pro/portal/home/'
$isChrome = $Browser -eq 'Chrome'
if (-not $Port) { $Port = if ($isChrome) { 9223 } else { 9222 } }
if ($isChrome) {
  $browserExe = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  $sourceUserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  $processName = 'chrome'
  $debugUserData = Join-Path $env:LOCALAPPDATA 'WeiyangMonitor\ChromeDebugData'
  $uiUserData = Join-Path $env:LOCALAPPDATA 'WeiyangMonitor\ChromeMonitorUI'
  if (-not $browserExe) { throw 'Google Chrome was not found. Install Chrome before using the Chrome launcher.' }
} else {
  $browserExe = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  $sourceUserData = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  $processName = 'msedge'
  $debugUserData = Join-Path $env:LOCALAPPDATA 'WeiyangMonitor\EdgeDebugData'
  $uiUserData = Join-Path $env:LOCALAPPDATA 'WeiyangMonitor\MonitorUI'
  if (-not $browserExe) { throw 'Microsoft Edge was not found.' }
}

# Re-running the launcher is safe when the monitor-owned browser is already open.
# A normal browser window without this port still triggers the safety check below.
$existingVersion = $null
try { $existingVersion = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 } catch { }
if ($existingVersion.webSocketDebuggerUrl) {
  # A previous monitor browser can keep the CDP endpoint alive while Playwright
  # can no longer attach (for example after a crashed scan). Recycle only the
  # process listening on the dedicated monitor port, then start a clean instance.
  # The normal user's browser has no listener on this port.
  $listeners = @()
  try {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { }
  foreach ($listenerPid in $listeners) {
    $process = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq $processName) {
      Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
    }
  }
  try { $existingVersion = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 } catch { $existingVersion = $null }
  if ($existingVersion.webSocketDebuggerUrl) {
    throw "Monitor port $Port is still occupied by another program. Close the $Browser instance using that port and retry, or pass a different -Port."
  }
}
if (-not (Test-Path -LiteralPath $sourceUserData)) { throw "$Browser user data directory not found: $sourceUserData" }
if (-not $ProfileDirectory) {
  if (Test-Path (Join-Path $sourceUserData 'Profile 1')) { $ProfileDirectory = 'Profile 1' }
  else { $ProfileDirectory = 'Default' }
}
$sourceProfile = Join-Path $sourceUserData $ProfileDirectory
if (-not (Test-Path -LiteralPath $sourceProfile)) { throw "$Browser profile not found: $ProfileDirectory." }

# Chromium 136+ ignores remote-debugging switches on its default user-data folder,
# so the selected profile is cloned once into a monitor-owned directory.
$debugProfile = Join-Path $debugUserData $ProfileDirectory
if ((-not (Test-Path -LiteralPath $debugProfile) -or $RefreshProfile) -and (Get-Process $processName -ErrorAction SilentlyContinue)) {
  Write-Host "Close every $Browser window before the first profile copy or a refresh. This is not needed once a monitor profile exists." -ForegroundColor Yellow
  exit 2
}
if ($RefreshProfile -and (Test-Path -LiteralPath $debugUserData)) {
  Remove-Item -LiteralPath $debugUserData -Recurse -Force
}
if (-not (Test-Path -LiteralPath $debugProfile)) {
  New-Item -ItemType Directory -Force -Path $debugUserData | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceUserData 'Local State') -Destination $debugUserData -Force
  New-Item -ItemType Directory -Force -Path $debugProfile | Out-Null
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  & $robocopy $sourceProfile $debugProfile /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XD 'Cache' 'Code Cache' 'GPUCache' 'ShaderCache' 'GrShaderCache' 'DawnCache' 'Crashpad' | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "Copying the $Browser profile failed, robocopy exit code: $LASTEXITCODE" }
  Write-Host "Copied $Browser profile $ProfileDirectory into the monitor-owned directory." -ForegroundColor Green
}

Write-Host "Starting remote debugging with the isolated $Browser profile $ProfileDirectory; your normal browser profile is not modified." -ForegroundColor Green
$browserArgs = @(
  "--remote-debugging-port=$Port",
  '--remote-allow-origins=*',
  "--user-data-dir=`"$debugUserData`"",
  "--profile-directory=$ProfileDirectory",
  '--no-first-run',
  '--disable-extensions'
)
if (-not $isChrome) { $browserArgs += '--disable-features=msEdgeSync' }
if ($NoDashboard) {
  # Background (auto-start) mode opens no browser window and does not load the
  # homepage; server.js navigates headlessly to the activity/profile pages.
  $browserArgs += @('--headless=new', 'about:blank')
} else {
  $browserArgs += $homeUrl
}
$browserProcess = Start-Process -FilePath $browserExe -ArgumentList $browserArgs -PassThru

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    if ($version.webSocketDebuggerUrl) { $ready = $true; break }
  } catch { }
  if ($browserProcess.HasExited) { break }
}
if (-not $ready) {
  Write-StartupEvent -Event 'browser-failed' -Detail "browser=$Browser port=$Port exited=$($browserProcess.HasExited)"
  $policy = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name RemoteDebuggingAllowed -ErrorAction SilentlyContinue
  if ($policy.RemoteDebuggingAllowed -eq 0) { throw 'Edge group policy forbids remote debugging (RemoteDebuggingAllowed=0). An administrator must change the policy.' }
  throw "$Browser remote debugging port $Port did not start. Browser exited: $($browserProcess.HasExited). Check browser policy or choose another -Port."
}
Write-StartupEvent -Event 'browser-ready' -Detail "browser=$Browser port=$Port pid=$($browserProcess.Id)"

if ($LoginOnly) { exit 0 }

$env:WEIYANG_CDP_URL = "http://127.0.0.1:$Port"
Write-Host "Connected to $Browser, starting the monitor backend: http://127.0.0.1:8787/" -ForegroundColor Green
# 本脚本在 scripts/ 下，项目根是上一级（package.json / node_modules 都在那边）。
# npm.cmd 必须在项目根执行，否则找不到 package.json。
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw 'npm.cmd was not found.' }
# Auto-start uses -NoDashboard: run the background monitor only, open no web page.
if (-not $NoDashboard) {
  New-Item -ItemType Directory -Force -Path $uiUserData | Out-Null
  Start-Process -FilePath $browserExe -ArgumentList @("--user-data-dir=`"$uiUserData`"", '--no-first-run', '--new-window', 'http://127.0.0.1:8787/')
}
$backendReady = $false
try {
  $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/state' -TimeoutSec 2
  $backendReady = $true
} catch { }
if ($backendReady) {
  Write-Host 'The monitor backend is already running on 127.0.0.1:8787; reusing it instead of starting a second copy.' -ForegroundColor Yellow
  Write-StartupEvent -Event 'backend-reused' -Detail 'url=http://127.0.0.1:8787'
  exit 0
}

# Start node through the wrapper so "starting / exited / crashed" are recorded.
Write-StartupEvent -Event 'backend-starting' -Detail 'url=http://127.0.0.1:8787'
$wrapper = Join-Path $PSScriptRoot 'wrap-npm-start.ps1'
if (Test-Path -LiteralPath $wrapper) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper -RootDirectory $ProjectRoot
  exit $LASTEXITCODE
}
& $npm start
