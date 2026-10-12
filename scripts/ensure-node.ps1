# Download a portable Node.js into %LOCALAPPDATA%\weiyang-node when the machine
# has no Node.js at all.
#
# WHY PORTABLE (no installer, no admin):
#   * the official .msi needs administrator rights and writes to Program Files;
#     the portable archive just unwraps into a folder under the user profile.
#   * tools\install-autostart.js and start-autostart.cmd already look for
#     node.exe in %LOCALAPPDATA%\weiyang-node, so the downloaded copy is picked
#     up by auto-start with no extra wiring.
#   * nothing is added to PATH permanently, so the machine is left as it was.
#
# WHY curl.exe + tar.exe instead of Invoke-WebRequest / Expand-Archive:
#   * curl.exe ships with Windows 10 1803+ and prints a real progress bar.
#     Invoke-WebRequest has no usable progress for a 30 MB download and buffers
#     it in memory when -OutFile is missing.
#   * the .tar.xz archive is roughly half the size of the .zip (about 30 MB vs
#     60 MB). bsdtar in System32 supports xz. Expand-Archive cannot read .xz.
#   * both tools are external processes, so no in-memory buffering either way.
#
# This script is IDEMPOTENT: if a working node.exe is already present (anywhere
# on this machine, or in the portable folder), it does nothing and exits 0.
#
# Pure ASCII on purpose. Windows PowerShell 5.1 would read a BOM-less UTF-8 file
# as ANSI, but this file is deliberately kept ASCII so the encoding question
# never arises.
#
# Exit codes: 0 = ready, 10 = download failed, 11 = extraction impossible,
#             12 = archive unusable, 13 = unusable result
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11

$DestDir = Join-Path $env:LOCALAPPDATA 'weiyang-node'
$NodeExe = Join-Path $DestDir 'node.exe'
$FallbackVersion = 'v22.20.0'

function Write-Line([string]$Text) { Write-Host $Text }

# --- 1. Is Node already available? -----------------------------------------
function Find-WorkingNode {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    $NodeExe
  )
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      try {
        $v = (& $c --version 2>$null | Select-Object -First 1)
        if ($v -match '^v\d+\.') { return @{ Exe = $c; Version = $v.Trim() } }
      } catch { }
    }
  }
  return $null
}

Write-Line ''
Write-Line '=== [1/4] Checking for Node.js ==='

if (-not $Force) {
  $existing = Find-WorkingNode
  if ($existing) {
    Write-Line ('  Found Node.js ' + $existing.Version)
    Write-Line ('  Path: ' + $existing.Exe)
    Write-Line '  Nothing to download.'
    exit 0
  }
}
Write-Line '  No working Node.js found on this machine.'
if ($Force) { Write-Line '  (-Force was given, refreshing the portable copy anyway.)' }

# --- 2. Work out which version to fetch ------------------------------------
Write-Line ''
Write-Line '=== [2/4] Looking up the current Node.js LTS release ==='

$version = ''
try {
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30 -UseBasicParsing
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  if ($lts -and $lts.version) { $version = $lts.version }
} catch {
  Write-Line ('  Could not read the release index: ' + $_.Exception.Message)
}

if ($version) {
  Write-Line ('  Current LTS: ' + $version)
} else {
  $version = $FallbackVersion
  Write-Line ('  Falling back to a known version: ' + $version)
}

# --- 3. Download ------------------------------------------------------------
$archiveName = 'node-' + $version + '-win-x64.tar.xz'
$directUrl = 'https://nodejs.org/dist/' + $version + '/' + $archiveName
# nodejs.org redirects latest-lts to the current release, so this URL survives
# version churn even if the index lookup above could not run.
$ltsUrl = 'https://nodejs.org/dist/latest-lts/' + $archiveName

$tempDir = Join-Path $env:TEMP ('weiyang-node-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$archive = Join-Path $tempDir $archiveName

$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path -LiteralPath $curl)) { $curl = 'curl.exe' }

$downloaded = $false
foreach ($url in @($directUrl, $ltsUrl)) {
  Write-Line ''
  Write-Line '=== [3/4] Downloading Node.js ==='
  Write-Line ('  From: ' + $url)
  Write-Line '  About 30 MB. This is a one-time download.'
  Write-Line ''
  try {
    # -L follows the latest-lts redirect, -f turns an HTTP error into a failure
    # instead of silently saving an error page, --retry handles transient drops.
    & $curl -L -f --retry 2 --retry-delay 2 --connect-timeout 20 --progress-bar -o "$archive" "$url"
    $code = $LASTEXITCODE
  } catch {
    $code = 1
  }
  if ($code -eq 0 -and (Test-Path -LiteralPath $archive) -and ((Get-Item -LiteralPath $archive).Length -gt 5MB)) {
    $downloaded = $true
    break
  }
  Write-Line ''
  Write-Line ('  That attempt failed (exit ' + $code + '). Trying another server path...')
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
}

if (-not $downloaded) {
  Write-Line ''
  Write-Line 'Could not download Node.js automatically.'
  Write-Line 'Please install it by hand, then run this launcher again:'
  Write-Line '    https://nodejs.org/en/download'
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 10
}

$sizeMB = [int]((Get-Item -LiteralPath $archive).Length / 1MB)
Write-Line ''
Write-Line ('  Downloaded ' + $sizeMB + ' MB.')

# --- 4. Unpack --------------------------------------------------------------
Write-Line ''
Write-Line '=== [4/4] Unpacking ==='

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) {
  Write-Line '  tar.exe is missing, so the archive cannot be unpacked.'
  Write-Line '  (tar.exe ships with Windows 10 version 1803 and newer.)'
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 11
}

$extractDir = Join-Path $tempDir 'unpacked'
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
& $tar -xf "$archive" -C "$extractDir"
if ($LASTEXITCODE -ne 0) {
  Write-Line ('  Unpacking failed (tar exit ' + $LASTEXITCODE + ').')
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 12
}

# The archive contains one top-level folder named after the version. Rather
# than reconstructing that name, just find node.exe wherever it landed.
$found = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'node.exe' -File -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $found) {
  Write-Line '  The archive did not contain node.exe.'
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 12
}
Write-Line ('  Found in archive: ' + $found.Directory.Name)

# Replace any previous copy only after a successful unpack, so an interrupted
# download can never leave the machine without a working Node.js.
if (Test-Path -LiteralPath $DestDir) {
  try {
    Remove-Item -LiteralPath $DestDir -Recurse -Force
  } catch {
    Write-Line ('  Could not replace ' + $DestDir + ': ' + $_.Exception.Message)
    Write-Line '  It is probably in use. Close the monitor and try again.'
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 13
  }
}
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Copy-Item -Path (Join-Path $found.Directory.FullName '*') -Destination $DestDir -Recurse -Force
Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue

# Prove the unpacked copy actually runs before declaring success.
if (-not (Test-Path -LiteralPath $NodeExe)) {
  Write-Line ('  Expected node.exe at ' + $NodeExe + ' but it is not there.')
  exit 13
}
$newVersion = ''
try { $newVersion = (& $NodeExe --version 2>$null | Select-Object -First 1) } catch { }
if ($newVersion -notmatch '^v\d+\.') {
  Write-Line '  The unpacked node.exe does not run.'
  exit 13
}

Write-Line ''
Write-Line ('Done. Portable Node.js ' + $newVersion.Trim() + ' is ready.')
Write-Line ('  ' + $NodeExe)
Write-Line '  Nothing was installed system-wide and PATH was not modified.'
exit 0
