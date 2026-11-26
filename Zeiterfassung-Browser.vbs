Option Explicit
' Oeffnet die Zeiterfassung im Standardbrowser (als Tab statt im eigenen Programmfenster), ohne Konsolenfenster.
' Laeuft sie noch nicht, wird sie dabei gestartet. Der Browser bekommt den Zugangsschluessel einmalig ueber die Adresse.
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\start-app.bat"" --browser", 0, False
