' Runs launch.ps1 without a console window. This is what the shortcut points at.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
args = "-NoProfile -ExecutionPolicy Bypass -File """ & here & "\launch.ps1"""
' Pass every argument through - a self-restart sends "-Restart -NoBrowser" together.
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

shell.Run "powershell.exe " & args, 0, False
