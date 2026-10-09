Option Explicit
Dim shell, fso, root, powershell, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(root)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
scriptPath = fso.BuildPath(fso.BuildPath(projectRoot, "scripts"), "start-edge-monitor.ps1")
command = Chr(34) & powershell & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34) & " -Browser Chrome -LoginOnly"
shell.Run command, 0, False
