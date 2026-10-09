' ===================================================================
'  Weiyang Monitor - silent auto-start entry point.
'
'  Launched by wscript.exe (see tools\install-autostart.js), which is a
'  GUI host and therefore creates NO console window. This is the whole
'  point of having this file: an earlier version put start-autostart.cmd
'  directly in the Startup folder, so Windows opened a console for it
'  (titled after the shortcut), and the backend started with "start /b"
'  was attached to that console -- closing the window killed the backend.
'  Verified: closing that window stopped port 8787.
'
'  This script runs the batch with window style 0 (hidden), so there is no
'  window to close and nothing for the backend to be attached to.
'
'  Logging is done by the batch, NOT here: the PowerShell logger used by
'  launchers\launch-monitor.vbs fails silently on this machine. The batch
'  appends to startup.log with cmd's own echo, which cannot fail silently.
'
'  Pure ASCII on purpose: WSH reads .vbs using the system ANSI code page.
'
'  To disable auto-start: node tools\install-autostart.js --remove
' ===================================================================
Option Explicit

Dim fso, shell, here, cmdPath, logPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve this script's own directory. Never rely on the current
' directory: wscript sets it to the shortcut's "Start in" folder.
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = fso.BuildPath(here, "start-autostart.cmd")
logPath = fso.BuildPath(here, "startup.log")

If Not fso.FileExists(cmdPath) Then
  ' Nothing to run. Record why, so the failure is not invisible.
  ' FileSystemObject writes ANSI; the batch writes ANSI too, so the log
  ' stays consistent. This is only a fallback path.
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logPath, 8, True)
  If Err.Number = 0 Then
    f.WriteLine Date & " " & Time & " | vbs-ERROR | missing=" & cmdPath
    f.Close
  End If
  On Error Goto 0
  WScript.Quit 2
End If

' 0 = hidden window, False = do not wait. The batch exits on its own once
' the backend is launched, so waiting would only block this script.
shell.Run """" & cmdPath & """", 0, False

WScript.Quit 0
