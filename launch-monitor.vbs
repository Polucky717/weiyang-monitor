Option Explicit

' Double-click launcher for Windows. It keeps the PowerShell helper hidden;
' the monitor itself runs in the background and Windows shows notifications.
'
' Startup-chain logging (used to audit whether auto-start ran on a given day):
' one line is appended to startup.log before the monitor is launched. If the
' logger is missing or fails it is skipped silently, so the monitor still
' starts normally (the call is synchronous with a hidden window).
Dim shell, fso, root, powershell, scriptPath, command
Dim loggerPath, loggerCommand, loggerDetail, launchCommand
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
scriptPath = fso.BuildPath(root, "start-edge-monitor.ps1")
loggerPath = fso.BuildPath(root, "log-startup-event.ps1")
command = ""

If fso.FileExists(loggerPath) Then
  loggerDetail = "vbs=launch-monitor.vbs"
  loggerCommand = Chr(34) & powershell & Chr(34) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & loggerPath & Chr(34) & " -Event auto-start-invoked -Detail " & Chr(34) & loggerDetail & Chr(34)
  On Error Resume Next
  shell.Run loggerCommand, 0, True
  On Error GoTo 0
End If

' ---------------------------------------------------------------------------
' The block below is byte-for-byte identical to the original launcher except for
' the two Chinese literals, which are written as ChrW() escapes so this file
' stays plain ASCII. VBScript decodes them to the same characters, and keeping
' the file ASCII removes any dependence on the ANSI code page (the previous
' UTF-16 file showed as "binary" to text tooling).
'
'   Original: MsgBox "找不到启动器：" & vbCrLf & scriptPath, 16, "未央观察站"
' ---------------------------------------------------------------------------
If Not fso.FileExists(scriptPath) Then
  MsgBox ChrW(25214) & ChrW(19981) & ChrW(21040) & ChrW(21551) & ChrW(21160) & ChrW(22120) & ChrW(65306) & vbCrLf & scriptPath, 16, ChrW(26410) & ChrW(22830) & ChrW(35266) & ChrW(23519) & ChrW(31449)
  WScript.Quit 2
End If

command = Chr(34) & powershell & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptPath & Chr(34) & " -NoDashboard"
launchCommand = command
shell.Run launchCommand, 0, False
