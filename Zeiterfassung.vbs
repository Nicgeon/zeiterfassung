Option Explicit
' Startet die Zeiterfassung als Programm (lokal) ohne Konsolenfenster: start-app.bat laeuft unsichtbar,
' der Starter oeffnet danach das App-Fenster. Doppelklick oder Verknuepfung (app-verknuepfung-erstellen.vbs).
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\start-app.bat""", 0, False
