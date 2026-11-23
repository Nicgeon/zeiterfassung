Option Explicit
' Legt auf dem Desktop und im Startmenue die Verknuepfungen "Zeiterfassung" und "Zeiterfassung Mini" an (mit Symbol).
' Ueber das Startmenue findet die Windows-Suche das Programm. (Das Startmenue legt das Programm beim Start auch selbst an.)
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Sub MakeLink(folder, name, target, text)
  Dim lnk
  Set lnk = sh.CreateShortcut(sh.SpecialFolders(folder) & "\" & name & ".lnk")
  lnk.TargetPath = dir & "\" & target
  lnk.WorkingDirectory = dir
  lnk.IconLocation = dir & "\public\favicon.ico"
  lnk.Description = text
  lnk.Save
End Sub

Dim f
For Each f In Array("Desktop", "Programs")
  MakeLink f, "Zeiterfassung", "Zeiterfassung.vbs", "Zeiterfassung starten"
  MakeLink f, "Zeiterfassung Mini", "Zeiterfassung-Mini.vbs", "Zeiterfassung als kleines Fenster starten"
Next
MsgBox "Die Verknuepfungen ""Zeiterfassung"" und ""Zeiterfassung Mini"" liegen jetzt auf dem Desktop und im Startmenue (Windows-Suche: ""Zeiterfassung"").", 64, "Zeiterfassung"
