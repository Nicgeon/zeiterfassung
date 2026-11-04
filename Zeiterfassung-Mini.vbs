Option Explicit
' Startet die Zeiterfassung als kleines Fenster (nur Aufgabe und Zeit), ohne Konsolenfenster.
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\start-app.bat"" --mini", 0, False
