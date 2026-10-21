Option Explicit
Dim shell, files, scriptDirectory, collector, node, command, result
If WScript.Arguments.Count < 1 Then WScript.Quit 1
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptDirectory = files.GetParentFolderName(WScript.ScriptFullName)
node = WScript.Arguments(0)
collector = files.BuildPath(scriptDirectory, "instagram-daily.mjs")
If WScript.Arguments.Count > 1 Then
    If WScript.Arguments(1) <> "--queued" Then WScript.Quit 1
    collector = files.BuildPath(scriptDirectory, "instagram-requests.mjs")
End If
shell.CurrentDirectory = files.GetParentFolderName(scriptDirectory)
command = Chr(34) & node & Chr(34) & " " & Chr(34) & collector & Chr(34)
' wscript has no console; window style 0 keeps the Node host silent.
' Wait for Node so Task Scheduler can prevent overlapping launcher instances.
result = shell.Run(command, 0, True)
WScript.Quit result
