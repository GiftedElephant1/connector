Option Explicit

Dim shell, files, root, scriptPath, powershell, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
scriptPath = files.BuildPath(root, "scripts\windows-update.ps1")

If Not files.FileExists(scriptPath) Then
  MsgBox "Extract both ZIP layers of the new Connector download, then open Update Connector from the extracted Connector folder.", vbExclamation, "Update Connector"
  WScript.Quit 1
End If

powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"
On Error Resume Next
result = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  MsgBox "Windows could not open the updater. Check that Windows PowerShell and Windows Script Host are available on this PC. Your organization's Windows policy may restrict downloaded applications.", vbExclamation, "Update Connector"
  WScript.Quit 1
End If
