Option Explicit
Dim shell, fso, root, startup, launcher, shortcut, shortcutName
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
startup = shell.SpecialFolders("Startup")
launcher = fso.BuildPath(root, "launch-chrome-monitor.vbs")
shortcutName = ChrW(&H672A) & ChrW(&H592E) & ChrW(&H96E8) & ChrW(&H8BFE) & ChrW(&H5802) & ChrW(&H6D3B) & ChrW(&H52A8) & ChrW(&H63D0) & ChrW(&H9192) & ".lnk"
Set shortcut = shell.CreateShortcut(fso.BuildPath(startup, shortcutName))
shortcut.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
shortcut.Arguments = Chr(34) & launcher & Chr(34)
shortcut.WorkingDirectory = root
shortcut.Description = "Start Weiyang monitor in headless Chrome"
shortcut.Save
MsgBox "Chrome 已设为开机后台监测浏览器。未创建桌面快捷方式。", 64, "Weiyang monitor"
