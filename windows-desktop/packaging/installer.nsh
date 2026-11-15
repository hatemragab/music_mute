!include "FileFunc.nsh"
!include "LogicLib.nsh"

; v26 one-click/per-user only. This guard runs before any app mutation.
!macro MusicMuteHostAndScope
  SetShellVarContext current
  ClearErrors
  ${GetOptions} $CMDLINE "/allusers" $R0
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "MusicMute installs only for the current Windows user."
    SetErrorLevel 64
    Quit
  ${EndIf}
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    ${If} $R0 != "$LOCALAPPDATA\Programs\MusicMute Local"
      MessageBox MB_OK|MB_ICONSTOP "MusicMute requires its fixed current-user installation folder."
      SetErrorLevel 64
      Quit
    ${EndIf}
  ${EndIf}
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\MusicMute Local"
  ; Native machine type, independent of this potentially I386 NSIS wrapper.
  ClearErrors
  System::Call 'kernel32::IsWow64Process2(p -1, *i.r0, *i.r1) i.r2'
  ${If} ${Errors}
    SetErrorLevel 64
    Quit
  ${EndIf}
  ; IsWow64Process2 writes USHORT fields; mask the plugin's 32-bit slots.
  IntOp $1 $1 & 0xffff
  ${If} $2 == 0
  ${OrIf} $1 != 0x8664
    MessageBox MB_OK|MB_ICONSTOP "MusicMute requires native Windows x64. Windows ARM and x86 are unsupported."
    SetErrorLevel 64
    Quit
  ${EndIf}
  System::Alloc 284
  Pop $0
  System::Call '*$0(i 284)'
  System::Call 'ntdll::RtlGetVersion(p r0) i.r1'
  ${If} $1 != 0
    System::Free $0
    SetErrorLevel 64
    Quit
  ${EndIf}
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  IntOp $5 $0 + 280
  System::Call '*$5(i.r6)'
  IntOp $6 $6 >> 16
  IntOp $6 $6 & 0xff
  System::Free $0
  ${If} $2 != 10
  ${OrIf} $4 < 19045
  ${OrIf} $6 != 1
    MessageBox MB_OK|MB_ICONSTOP "MusicMute requires Windows 10 22H2 (19045) or Windows 11 x64."
    SetErrorLevel 64
    Quit
  ${EndIf}
  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p.r0) i.r1'
  ${If} $1 == 0
    SetErrorLevel 64
    Quit
  ${EndIf}
  System::Call 'advapi32::GetTokenInformation(p r0, i 20, *i.r1, i 4, *i.r2) i.r3'
  System::Call 'kernel32::CloseHandle(p r0)'
  ${If} $3 == 0
  ${OrIf} $1 != 0
    MessageBox MB_OK|MB_ICONSTOP "Run MusicMute setup without administrator privileges."
    SetErrorLevel 64
    Quit
  ${EndIf}
!macroend

!macro MusicMutePathPreflight
  !insertmacro MusicMuteHostAndScope
  InitPluginsDir
  File /oname=$PLUGINSDIR\musicmute-path-preflight.exe "${BUILD_RESOURCES_DIR}\musicmute-native.exe"
  ClearErrors
  ExecWait '"$PLUGINSDIR\musicmute-path-preflight.exe" --installer-path-preflight' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "MusicMute could not verify its fixed private installation folder."
    SetErrorLevel 64
    Quit
  ${EndIf}
!macroend

!macro MusicMuteMaintenance ACTION
  !insertmacro MusicMuteHostAndScope
  IfFileExists "$INSTDIR\MusicMute Local.exe" 0 musicmute_no_app_${ACTION}
  ; Normal signed Electron, with native signed-installer peer verification.
  ; Arguments alone do not authorize shutdown, unregister or file replacement.
  ClearErrors
  ExecWait '"$INSTDIR\MusicMute Local.exe" --installer-maintenance ${ACTION}' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "MusicMute is busy or could not confirm safe cleanup. Finish active work and retry."
    SetErrorLevel 65
    Quit
  ${EndIf}
  Goto musicmute_checked_${ACTION}
musicmute_no_app_${ACTION}:
  InitPluginsDir
  File /oname=$PLUGINSDIR\musicmute-preflight.exe "${BUILD_RESOURCES_DIR}\musicmute-native.exe"
  ClearErrors
  ExecWait '"$PLUGINSDIR\musicmute-preflight.exe" --installer-preflight' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Another MusicMute session is active for this Windows account. Sign out of that login before continuing."
    SetErrorLevel 65
    Quit
  ${EndIf}
musicmute_checked_${ACTION}:
!macroend

!macro customHeader
  !ifdef INSTALL_MODE_PER_ALL_USERS
    !error "MusicMute rejects machine-scope installer compilation"
  !endif
  !ifndef ONE_CLICK
    !error "MusicMute requires oneClick true"
  !endif
  !ifdef BUILD_UNINSTALLER
    VIAddVersionKey /LANG=1033 "OriginalFilename" "MusicMuteLocalUninstall.exe"
  !else
    VIAddVersionKey /LANG=1033 "OriginalFilename" "MusicMuteLocalSetup.exe"
  !endif
!macroend
; v26 CHECK_APP_RUNNING has this hook; using it avoids its taskkill branch.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    !insertmacro MusicMuteMaintenance uninstall
  !else
    !insertmacro MusicMuteMaintenance install
  !endif
!macroend

!macro preInit
  !insertmacro MusicMutePathPreflight
!macroend
!macro customInit
  !insertmacro MusicMuteMaintenance install
!macroend
!macro customUnInit
  !insertmacro MusicMuteHostAndScope
!macroend
!macro customInstall
  ClearErrors
  ExecWait '"$INSTDIR\MusicMute Local.exe" --installer-maintenance register' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "MusicMute files were installed, but owned integration registration requires repair."
    SetErrorLevel 66
    Quit
  ${EndIf}
!macroend
!macro customRemoveFiles
  ; Generated exact package-owned file inventory. Unknown files are preserved;
  ; per-user data/runtime/fleet roots never appear in this include.
  !include "${BUILD_RESOURCES_DIR}\remove-owned-files.nsh"
!macroend
