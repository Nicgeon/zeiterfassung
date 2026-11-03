Option Explicit
' Legt auf dem Desktop die Verknuepfung "Zeiterfassung" an (startet Zeiterfassung.vbs, mit Symbol).
Dim sh, fso, dir, lnk
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Zeiterfassung.lnk")
lnk.TargetPath = dir & "\Zeiterfassung.vbs"
lnk.WorkingDirectory = dir
lnk.IconLocation = dir & "\public\favicon.ico"
lnk.Description = "Zeiterfassung starten"
lnk.Save
MsgBox "Die Verknuepfung ""Zeiterfassung"" liegt jetzt auf dem Desktop.", 64, "Zeiterfassung"
