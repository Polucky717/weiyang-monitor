$ErrorActionPreference = 'Stop'
try {
  # Close a stale test window from an earlier click so every test produces one
  # visible reminder instead of leaving the new window behind it.
  Get-Process -Name powershell -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq '未央雨课堂活动提醒测试' } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  # The server creates the single production notification after fetching a live activity.
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/test-notification' -TimeoutSec 90 | Out-Null
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $message = $_.Exception.Message
  $responseBody = $_.ErrorDetails.Message
  if ($responseBody) {
    try {
      $serverError = $responseBody | ConvertFrom-Json
      if ($serverError.error) { $message = [string]$serverError.error }
    } catch {
      $message = $responseBody
    }
  }
  [System.Windows.Forms.MessageBox]::Show(
    "无法触发活动提醒：$message",
    '未央雨课堂实时抓取失败',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
