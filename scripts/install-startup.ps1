param(
  # 加 -Remove 则从开机启动里移除，不做安装。
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
# 本脚本位于 scripts/，项目根是它的上一级。
# 注意：不能用 $MyInvocation.MyCommand.Path 算父目录 —— 用 -File 执行时它等于脚本自身路径，
# Split-Path -Parent 会得到 scripts/ 而不是项目根，导致下面的 launchers\ 路径算错。
$projectRoot = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup '未央观察站.lnk'
$legacyShortcutPath = Join-Path $startup '未央雨课堂活动提醒.lnk'
$shell = New-Object -ComObject WScript.Shell

if ($Remove) {
  $removed = 0
  foreach ($p in @($shortcutPath, $legacyShortcutPath)) {
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Force
      Write-Host "已移除开机启动：$p"
      $removed++
    }
  }
  if ($removed -eq 0) { Write-Host '开机启动里本来就没有本项目的条目。' }
  exit 0
}

$shortcut = $shell.CreateShortcut($shortcutPath)
$launcher = Join-Path $projectRoot 'launchers\launch-monitor.vbs'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "找不到启动器：$launcher（项目目录可能被移动过）"
}
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.TargetPath = $wscript
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '后台启动未央观察站，不打开终端或网页'
$shortcut.Save()
if (Test-Path -LiteralPath $legacyShortcutPath) {
  Remove-Item -LiteralPath $legacyShortcutPath -Force
}
Write-Host "已加入当前用户开机启动：$shortcutPath"
