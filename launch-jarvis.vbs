' JARVIS launcher — wakes WSL, waits inside WSL until Ollama answers, then opens JARVIS.
' Run via Wscript.exe (silent, no console flash). Target of the desktop shortcut.

Option Explicit

Dim WshShell, fso, jarvisExe, waitCmd
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

jarvisExe = "C:\Users\vdzoo\Projects\jarvis-local\src-tauri\target\release\jarvis-local.exe"

If Not fso.FileExists(jarvisExe) Then
    MsgBox "JARVIS .exe not found at:" & vbCrLf & jarvisExe & vbCrLf & vbCrLf & _
           "Run 'npm run tauri build' in the project folder first.", vbCritical, "JARVIS"
    WScript.Quit 1
End If

' Wake WSL and block until Ollama answers from INSIDE WSL.
' `timeout 30` caps total wait. If Ollama can't start in 30s we proceed anyway —
' the user can Ctrl+R inside JARVIS once it's up.
waitCmd = "wsl -d Ubuntu-24.04 -e bash -c ""timeout 30 bash -c 'until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do sleep 0.5; done'"""
WshShell.Run waitCmd, 0, True

' Brief grace period for WSL2 port-forwarding to expose 11434 to Windows.
WScript.Sleep 500

' Launch JARVIS.
WshShell.Run """" & jarvisExe & """", 1, False
