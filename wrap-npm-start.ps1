<#
  npm start wrapper (records backend service start / exit only)

  Why it exists:
    In PowerShell, `& $npm start` is a blocking call and nothing runs after the
    child exits, so the two most useful events - "service is ready" and
    "service exited (crashed)" - could never be recorded.

  Behaviour:
    1. npm stdout/stderr still goes to the console (original behaviour) and is
       additionally written to logs\server.log;
    2. "launching / exited / crashed" events are appended to startup.log;
    3. On a non-zero exit code the last lines of service output are included,
       so the crash cause is visible in the startup log.

  Note: cmd redirection is used instead of Tee-Object, because Tee-Object can
  lose buffered content when the pipeline ends, which made the start log
  unreliable.

  This file is intentionally pure ASCII: Windows PowerShell 5.1 (the engine
  WSH launches) mis-parses some multibyte comment characters and reports
  bogus "Try statement is missing its Catch or Finally block" parse errors.
#>
[CmdletBinding()]
param(
  [string]$RootDirectory = '',
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RootDirectory) { $RootDirectory = $PSScriptRoot }
if (-not $LogPath) { $LogPath = Join-Path $RootDirectory 'startup.log' }

function Write-StartupEvent {
  param([string]$Event, [string]$Detail = '')
  try {
    $logger = Join-Path $PSScriptRoot 'log-startup-event.ps1'
    if (Test-Path -LiteralPath $logger) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $logger -Event $Event -Detail $Detail -LogPath $LogPath | Out-Null
    }
  } catch { }
}

function Add-Tail {
  param([string]$File, [string]$Text)
  # -Encoding must be UTF8: Windows PowerShell 5.1 has no "utf8BOM" enumerator.
  try { Add-Content -LiteralPath $File -Value $Text -Encoding UTF8 -ErrorAction Stop } catch { }
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm.exe -ErrorAction SilentlyContinue).Source }
if (-not $npm) {
  Write-StartupEvent -Event 'npm-start-failed' -Detail 'reason=npm-not-found'
  throw 'npm not found. Install Node.js LTS first: https://nodejs.org/'
}

$logDir = Join-Path $RootDirectory 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$serverLog = Join-Path $logDir 'server.log'

Add-Tail -File $serverLog -Text ("`r`n===== npm start @ {0} (wrapper pid {1}) =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID)

Write-StartupEvent -Event 'npm-start-launching' -Detail ("pid={0} log={1}" -f $PID, $serverLog)

$startedAt = Get-Date
# 2>&1 funnels stderr into the same file; cmd redirection flushes on exit.
& cmd.exe /c "`"$npm`" start 1>>`"$serverLog`" 2>&1"
$exitCode = $LASTEXITCODE
$seconds = [int]((Get-Date) - $startedAt).TotalSeconds

$tail = ''
try {
  if (Test-Path -LiteralPath $serverLog) {
    $tail = (Get-Content -LiteralPath $serverLog -Tail 8 -Encoding utf8 -ErrorAction Stop) -join ' / '
    if ($tail.Length -gt 600) { $tail = $tail.Substring($tail.Length - 600) }
  }
} catch { }

if ($exitCode -eq 0) {
  Write-StartupEvent -Event 'npm-start-exited' -Detail ("code=0 seconds={0} tail={1}" -f $seconds, $tail)
} else {
  Write-StartupEvent -Event 'npm-start-crashed' -Detail ("code={0} seconds={1} tail={2}" -f $exitCode, $seconds, $tail)
}

exit $exitCode
