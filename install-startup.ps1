$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup '未央观察站.lnk'
$legacyShortcutPath = Join-Path $startup '未央雨课堂活动提醒.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$launcher = Join-Path $projectRoot 'launch-monitor.vbs'
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
