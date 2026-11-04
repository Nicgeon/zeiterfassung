Option Explicit
' Legt auf dem Desktop die Verknuepfungen "Zeiterfassung" und "Zeiterfassung Mini" an (mit Symbol).
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Sub MakeLink(name, target, text)
  Dim lnk
  Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\" & name & ".lnk")
  lnk.TargetPath = dir & "\" & target
  lnk.WorkingDirectory = dir
  lnk.IconLocation = dir & "\public\favicon.ico"
  lnk.Description = text
  lnk.Save
End Sub

MakeLink "Zeiterfassung", "Zeiterfassung.vbs", "Zeiterfassung starten"
MakeLink "Zeiterfassung Mini", "Zeiterfassung-Mini.vbs", "Zeiterfassung als kleines Fenster starten"
MsgBox "Die Verknuepfungen ""Zeiterfassung"" und ""Zeiterfassung Mini"" liegen jetzt auf dem Desktop.", 64, "Zeiterfassung"
