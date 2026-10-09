<#
  Startup-chain event logger

  Purpose: append one line to startup.log at each key node of the launch chain
        (Startup folder shortcut -> wscript -> launch-monitor.vbs ->
         start-edge-monitor.ps1 -> node server.js)
        so you can later audit whether auto-start actually ran on a given day.

  Design constraints (important):
    1. This script must never throw and never block. Any failure exits
       silently with code 0 - a broken logger must not stop the monitor
       from starting.
    2. Append only. No rotation, no deletion of history.
    3. Log file: startup.log in the project root (UTF-8 with BOM).

  This file is intentionally pure ASCII: Windows PowerShell 5.1 (the engine
  WSH launches) mis-parses some multibyte comment characters, which produced
  "The Try statement is missing its Catch or Finally block" parse errors.

  Log line format (pipe separated, machine readable):
    2026-10-09 08:24:50 | auto-start-invoked | vbs=launch-monitor.vbs
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Event,
  [string]$Detail = '',
  [string]$LogPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'

try {
  if (-not $LogPath) {
    # 本脚本在 scripts/ 下，而 startup.log 在项目根（见文件头说明），所以要上退一级。
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
    $LogPath = Join-Path $ProjectRoot 'startup.log'
  }

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = '{0} | {1}' -f $stamp, $Event
  if ($Detail) { $line = '{0} | {1}' -f $line, $Detail }

  # Append, retrying up to 12 times (~150ms apart) to tolerate transient locks.
  # NOTE: -Encoding must be UTF8. Windows PowerShell 5.1 does not recognise
  # the PS7-only "utf8BOM" enumerator name; its UTF8 writes a BOM anyway.
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
} catch {
  # All exceptions deliberately swallowed: logging must never block startup.
}

exit 0
