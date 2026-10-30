Option Explicit
Dim shell, files, directory, command, result
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
directory = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = files.GetParentFolderName(directory)
command = Chr(34) & WScript.Arguments(0) & Chr(34) & " " & Chr(34) & files.BuildPath(directory, "browser-requests.mjs") & Chr(34)
result = shell.Run(command, 0, True)
WScript.Quit result
