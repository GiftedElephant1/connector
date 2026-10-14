Option Explicit

Dim shell, files, root, scriptPath, powershell, command, result, background
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
scriptPath = files.BuildPath(root, "scripts\windows-launcher.ps1")

If Not files.FileExists(scriptPath) Then
  MsgBox "Extract the entire Connector ZIP first, then open Start Connector from the extracted folder.", vbExclamation, "Connector"
  WScript.Quit 1
End If

powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"
background = False
If WScript.Arguments.Count > 0 Then
  background = (LCase(WScript.Arguments(0)) = "/background")
End If
If background Then command = command & " -Background"
On Error Resume Next
result = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  MsgBox "Windows could not open Connector. Check that Windows PowerShell and Windows Script Host are available on this PC. Your organization's Windows policy may restrict downloaded applications.", vbExclamation, "Connector"
  WScript.Quit 1
End If
