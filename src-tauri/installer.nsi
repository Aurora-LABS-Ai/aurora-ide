; Aurora — Windows installer template (NSIS, rendered by the Tauri bundler).
;
; This is Tauri's own template for tauri-cli 2.9.6
; (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi at tauri-cli-v2.9.6),
; with ONLY the installer's pages replaced. Everything that installs, updates
; and uninstalls — WebView2, files, registry, shortcuts, the uninstaller and its
; pages, passive/silent/update modes — is Tauri's text, unchanged, so an update
; to Tauri's template is merged by diffing that file against this one.
;
; The pages (probe `Documents/aurora-installer-designs.html`, card 03, Alvan's
; pick 2026-10-16): one dark Aurora screen instead of Welcome → folder → Finish.
;   1. Install    the mark, the folder, two options, Install. On a machine that
;                 already has Aurora: Update / Reinstall, and Uninstall.
;   2. Installing the same window, a progress line, the current step.
;   3. Done       Open Aurora / Close.
; NSIS draws native Windows controls, so the look is built from what Win32
; allows: a dark window and title bar, labels as buttons (a plain push button
; cannot take the accent fill), checkboxes beside their own labels (a themed
; checkbox ignores text colour), a recoloured progress bar. Enter and Esc still
; reach the hidden Next/Cancel buttons, so the keyboard works as before.

Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
${StrCase}
${StrLoc}

; Aurora: set by the Install page, read by the hooks below. Declared before the
; hooks are included so their macros can use them.
Var AurDesktop      ; 1 = create the desktop shortcut
Var AurAddCli       ; 1 = put `aurora` on PATH (installer-hooks.nsh)

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_BITMAP  "${HEADERIMAGE}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; ═══════════════════════════════════════════════════════════════════════════
; Aurora — the look
; ═══════════════════════════════════════════════════════════════════════════

; Colours: Aurora's dark theme (--agw-conversation, text, muted, surface,
; border, accent). SetCtlColors takes RRGGBB.
!define AUR_BG 0x141414
!define AUR_TEXT 0xF2F2F2
!define AUR_MUTED 0x9A9A9A
!define AUR_FIELD 0x1D1D1D
!define AUR_BUTTON 0x262626
!define AUR_ACCENT 0x8E8243
!define AUR_ON_ACCENT 0xFFFFFF
; Win32 COLORREF is 0x00BBGGRR.
!define AUR_ACCENT_BGR 0x43828E
!define AUR_TRACK_BGR 0x262626
!define AUR_BG_BGR 0x141414

; Static styles: SS_NOTIFY | SS_CENTER | SS_CENTERIMAGE for a label that acts
; as a button; SS_ICON | SS_REALSIZECONTROL for the mark.
!define AUR_BUTTON_STYLE 0x50000301
!define AUR_ICON_STYLE 0x50000143

Var AurDpi
Var AurFontTitle
Var AurFontBody
Var AurFontStrong
Var AurFontSmall
Var AurDialog
Var AurW
Var AurH
Var AurState        ; "" new install | same | older | newer | wix
Var AurOldVersion
Var AurWixKey
Var AurPathEdit
Var AurDeskCheck
Var AurCliCheck
Var AurOpen         ; Done page: 1 = open Aurora when the window closes
Var AurIcon

; px at 96 dpi → px on this screen
!macro AurPx _OUT _V
  IntOp ${_OUT} ${_V} * $AurDpi
  IntOp ${_OUT} ${_OUT} / 96
!macroend

; A control at design pixels, scaled. Leaves the handle in _VAR.
!macro AurControl _VAR _CLASS _STYLE _EXSTYLE _X _Y _W _H _TEXT
  !insertmacro AurPx $R6 ${_X}
  !insertmacro AurPx $R7 ${_Y}
  !insertmacro AurPx $R8 ${_W}
  !insertmacro AurPx $R9 ${_H}
  nsDialogs::CreateControl ${_CLASS} ${_STYLE} ${_EXSTYLE} $R6 $R7 $R8 $R9 `${_TEXT}`
  Pop ${_VAR}
!macroend

!macro AurLabel _VAR _X _Y _W _H _TEXT _COLOR _FONT
  !insertmacro AurControl ${_VAR} STATIC ${__NSD_Label_STYLE} 0 ${_X} ${_Y} ${_W} ${_H} `${_TEXT}`
  SetCtlColors ${_VAR} ${_COLOR} ${AUR_BG}
  SendMessage ${_VAR} ${WM_SETFONT} ${_FONT} 1
!macroend

!macro AurButton _VAR _X _Y _W _H _TEXT _PRIMARY _FUNC
  !insertmacro AurControl ${_VAR} STATIC ${AUR_BUTTON_STYLE} 0 ${_X} ${_Y} ${_W} ${_H} `${_TEXT}`
  !if ${_PRIMARY} == 1
    SetCtlColors ${_VAR} ${AUR_ON_ACCENT} ${AUR_ACCENT}
    SendMessage ${_VAR} ${WM_SETFONT} $AurFontStrong 1
  !else
    SetCtlColors ${_VAR} ${AUR_TEXT} ${AUR_BUTTON}
    SendMessage ${_VAR} ${WM_SETFONT} $AurFontBody 1
  !endif
  ${NSD_OnClick} ${_VAR} ${_FUNC}
!macroend

; The Aurora mark, from the installer's own icon resource at the size asked.
!macro AurMark _X _Y _SIZE
  !insertmacro AurControl $AurIcon STATIC ${AUR_ICON_STYLE} 0 ${_X} ${_Y} ${_SIZE} ${_SIZE} ""
  SetCtlColors $AurIcon "" ${AUR_BG}
  !insertmacro AurPx $R5 ${_SIZE}
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r9'
  System::Call 'user32::LoadImageW(p r9, p 103, i 1, i $R5, i $R5, i 0) p .r8'
  SendMessage $AurIcon ${STM_SETICON} $8 0
!macroend

; Theme a native control for a dark window (Windows 10 1809+; older ones keep
; the light look, still readable).
!macro AurDarkTheme _HWND _CLASS
  System::Call 'uxtheme::SetWindowTheme(p ${_HWND}, w "${_CLASS}", p 0)'
!macroend

; Next and Cancel are moved out of sight, not hidden: a dialog ignores Enter
; and Esc for a hidden button (checked live, 2026-10-16 — Esc did nothing), and
; those keys are how the keyboard reaches Install and Cancel on our pages.
!macro AurHideOuterButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  System::Call "user32::SetWindowPos(p r0, p 0, i -3000, i -3000, i 0, i 0, i 0x15)"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  System::Call "user32::SetWindowPos(p r0, p 0, i -3000, i -3000, i 0, i 0, i 0x15)"
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
!macroend

; The page area in design pixels, from the dialog nsDialogs just made.
!macro AurMeasure _HWND
  System::Call "*(i,i,i,i) p .r1"
  System::Call "user32::GetClientRect(p ${_HWND}, p r1)"
  System::Call "*$1(i, i, i .r2, i .r3)"
  System::Free $1
  IntOp $AurW $2 * 96
  IntOp $AurW $AurW / $AurDpi
  IntOp $AurH $3 * 96
  IntOp $AurH $AurH / $AurDpi
!macroend

!define MUI_CUSTOMFUNCTION_GUIINIT AurGuiInit
Function AurGuiInit
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $AurDpi $0

  CreateFont $AurFontTitle "Segoe UI Semibold" 15 600
  CreateFont $AurFontBody "Segoe UI" 9 400
  CreateFont $AurFontStrong "Segoe UI Semibold" 9 600
  CreateFont $AurFontSmall "Segoe UI" 8 400

  ; Dark title bar, and on Windows 11 the caption painted the window's colour.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${AUR_BG_BGR}, i 4)'

  SetCtlColors $HWNDPARENT ${AUR_TEXT} ${AUR_BG}

  ; No header, no branding line, no separators: the page is the whole window.
  ; The header's own background (1034) is stretched over the client area as
  ; the window's paint, since the dialog itself keeps the system colour.
  System::Call "*(i,i,i,i) p .r1"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r1)"
  System::Call "*$1(i, i, i .r2, i .r3)"
  System::Free $1
  GetDlgItem $0 $HWNDPARENT 1034
  SetCtlColors $0 "" ${AUR_BG}
  System::Call "user32::SetWindowPos(p r0, p 1, i 0, i 0, i r2, i r3, i 0x10)"
  ${ForEach} $4 1035 1039 + 1
    GetDlgItem $0 $HWNDPARENT $4
    ${If} $4 <> 1035
    ${OrIf} $4 = 1035
      ${If} $4 <> 1034
        ShowWindow $0 ${SW_HIDE}
      ${EndIf}
    ${EndIf}
  ${Next}
  ${ForEach} $4 1028 1028 + 1
    GetDlgItem $0 $HWNDPARENT $4
    ShowWindow $0 ${SW_HIDE}
  ${Next}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}

  ; Pages fill the window: the placeholder every inner page is created in.
  GetDlgItem $0 $HWNDPARENT 1018
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r3, i 0x14)"

  ; The one native button still seen (Installing → Cancel), in the dark theme.
  GetDlgItem $0 $HWNDPARENT 2
  !insertmacro AurDarkTheme $0 "DarkMode_Explorer"
FunctionEnd

; Is Aurora already here, and how does its version compare? Tauri's own
; detection (its PageReinstall), kept as it was, written into Aur* variables.
Function AurDetectInstall
  StrCpy $AurState ""
  StrCpy $0 0
  aur_wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" aur_wix_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 aur_wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 aur_wix_done
    StrCpy $WixMode 1
    StrCpy $AurWixKey "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    ReadRegStr $AurOldVersion HKLM "$AurWixKey" "DisplayVersion"
    StrCpy $AurState "wix"
    Return
  aur_wix_done:

  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$R0$R1" == ""
    Return
  ${EndIf}

  ReadRegStr $AurOldVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $AurOldVersion == ""
    StrCpy $AurState "older"
    Return
  ${EndIf}
  nsis_tauri_utils::SemverCompare "${VERSION}" $AurOldVersion
  Pop $R0
  ${If} $R0 = 0
    StrCpy $AurState "same"
  ${ElseIf} $R0 = 1
    StrCpy $AurState "older"
  ${Else}
    StrCpy $AurState "newer"
  ${EndIf}
FunctionEnd

; Remove a WiX (MSI) install first — Tauri always does, and so do we.
Function AurUninstallWix
  HideWindow
  ClearErrors
  ReadRegStr $R1 HKLM "$AurWixKey" "UninstallString"
  ExecWait '$R1' $0
  BringToFront
  ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}
  ${If} $0 <> 0
    ${If} $0 = 1602
      Abort
    ${EndIf}
    MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
    Abort
  ${EndIf}
FunctionEnd

; ── Page 1: Install (or Update / Reinstall) ──────────────────────────────
Page custom AurInstallPage AurInstallLeave

Function AurInstallPage
  Call AurDetectInstall

  ; Passive (the updater) and silent runs show no page. Tauri's rules: update
  ; mode installs over; a WiX install is removed first.
  ${If} $PassiveMode = 1
    ${If} $AurState == "wix"
      Call AurUninstallWix
    ${EndIf}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $AurDialog
  ${If} $AurDialog == error
    Abort
  ${EndIf}
  SetCtlColors $AurDialog ${AUR_TEXT} ${AUR_BG}
  !insertmacro AurHideOuterButtons
  !insertmacro AurMeasure $AurDialog

  !insertmacro AurMark 28 26 48

  ; Title and the line under it, per state.
  ${If} $AurState == ""
    StrCpy $1 "${PRODUCTNAME}"
    StrCpy $2 "Version ${VERSION}"
  ${ElseIf} $AurState == "same"
    StrCpy $1 "${PRODUCTNAME} ${VERSION} is installed"
    StrCpy $2 "In $INSTDIR"
  ${ElseIf} $AurState == "older"
    StrCpy $1 "Update ${PRODUCTNAME}"
    ${If} $AurOldVersion == ""
      StrCpy $2 "To version ${VERSION}"
    ${Else}
      StrCpy $2 "From $AurOldVersion to ${VERSION}"
    ${EndIf}
  ${ElseIf} $AurState == "newer"
    StrCpy $1 "A newer ${PRODUCTNAME} is installed"
    StrCpy $2 "Installed: $AurOldVersion · this installer: ${VERSION}"
  ${Else}
    StrCpy $1 "Update ${PRODUCTNAME}"
    StrCpy $2 "Replaces the copy installed from the MSI package"
  ${EndIf}
  IntOp $5 $AurW - 116
  !insertmacro AurLabel $0 90 28 $5 28 $1 ${AUR_TEXT} $AurFontTitle
  !insertmacro AurLabel $0 90 58 $5 18 $2 ${AUR_MUTED} $AurFontBody

  ${If} $AurState == ""
  ${OrIf} $AurState == "wix"
    ; Where, and the two choices.
    !insertmacro AurLabel $0 28 108 200 16 "Install to" ${AUR_MUTED} $AurFontBody
    IntOp $5 $AurW - 154
    !insertmacro AurControl $AurPathEdit EDIT "${__NSD_Text_STYLE}|0x800" ${__NSD_Text_EXSTYLE} 28 128 $5 28 $INSTDIR
    SetCtlColors $AurPathEdit ${AUR_TEXT} ${AUR_FIELD}
    SendMessage $AurPathEdit ${WM_SETFONT} $AurFontBody 1
    !insertmacro AurDarkTheme $AurPathEdit "DarkMode_CFD"
    IntOp $5 $AurW - 118
    !insertmacro AurButton $0 $5 128 90 28 "Change…" 0 AurChangeFolder

    StrCpy $6 1
    ${If} $NoShortcutMode = 1
      StrCpy $6 0
    ${EndIf}
    IntOp $5 $AurW - 80
    !insertmacro AurControl $AurDeskCheck BUTTON ${__NSD_CheckBox_STYLE} 0 28 174 16 16 ""
    !insertmacro AurDarkTheme $AurDeskCheck "DarkMode_Explorer"
    SetCtlColors $AurDeskCheck "" ${AUR_BG}
    ${If} $6 = 1
      SendMessage $AurDeskCheck ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}
    !insertmacro AurLabel $0 52 173 $5 18 "Create a desktop shortcut" ${AUR_TEXT} $AurFontBody
    ${NSD_OnClick} $0 AurToggleDesk

    !insertmacro AurControl $AurCliCheck BUTTON ${__NSD_CheckBox_STYLE} 0 28 200 16 16 ""
    !insertmacro AurDarkTheme $AurCliCheck "DarkMode_Explorer"
    SetCtlColors $AurCliCheck "" ${AUR_BG}
    ${If} $AurAddCli = 1
      SendMessage $AurCliCheck ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}
    !insertmacro AurLabel $0 52 199 $5 18 "Add the aurora command to the terminal" ${AUR_TEXT} $AurFontBody
    ${NSD_OnClick} $0 AurToggleCli

    IntOp $0 ${ESTIMATEDSIZE} / 1024
    !if "${INSTALLMODE}" == "currentUser"
      StrCpy $1 "$0 MB · just for you, no admin needed"
    !else
      StrCpy $1 "$0 MB"
    !endif
    IntOp $5 $AurH - 44
    !insertmacro AurLabel $0 28 $5 230 18 $1 ${AUR_MUTED} $AurFontSmall
    StrCpy $1 "Install"
  ${Else}
    ; Already installed: what updating keeps, and what uninstalling leaves.
    StrCpy $AurDesktop 0
    IntOp $5 $AurW - 56
    ${If} $AurState == "newer"
      !if "${ALLOWDOWNGRADES}" == "true"
        StrCpy $3 "Installing this older version replaces the newer one. Your chats, settings and projects stay."
      !else
        StrCpy $3 "This installer is older than the installed ${PRODUCTNAME}, and downgrading is turned off. Uninstall first to install it."
      !endif
    ${Else}
      StrCpy $3 "Your chats, settings and projects stay. Uninstalling removes the app; your chats stay in %LOCALAPPDATA%\AuroraIDE."
    ${EndIf}
    !insertmacro AurLabel $0 28 108 $5 60 $3 ${AUR_MUTED} $AurFontBody

    IntOp $5 $AurH - 50
    !insertmacro AurButton $0 28 $5 100 30 "Uninstall" 0 AurUninstallClick

    ${If} $AurState == "same"
      StrCpy $1 "Reinstall"
    ${ElseIf} $AurState == "newer"
      StrCpy $1 "Install anyway"
    ${Else}
      StrCpy $1 "Update"
    ${EndIf}
  ${EndIf}

  ; Footer: Cancel, then the primary action.
  IntOp $5 $AurW - 236
  IntOp $6 $AurH - 50
  !insertmacro AurButton $0 $5 $6 96 30 "Cancel" 0 AurCancelClick
  IntOp $5 $AurW - 128
  !insertmacro AurButton $7 $5 $6 100 30 $1 1 AurNextClick
  !if "${ALLOWDOWNGRADES}" == "false"
    ${If} $AurState == "newer"
      EnableWindow $7 0
      SetCtlColors $7 ${AUR_MUTED} ${AUR_BUTTON}
      GetDlgItem $0 $HWNDPARENT 1
      EnableWindow $0 0
    ${EndIf}
  !endif

  nsDialogs::Show
FunctionEnd

Function AurInstallLeave
  ${If} $AurState == ""
  ${OrIf} $AurState == "wix"
    ${NSD_GetState} $AurDeskCheck $AurDesktop
    ${NSD_GetState} $AurCliCheck $AurAddCli
  ${EndIf}
  ${If} $AurState == "wix"
    Call AurUninstallWix
  ${EndIf}
FunctionEnd

Function AurNextClick
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AurCancelClick
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function AurToggleDesk
  ${NSD_GetState} $AurDeskCheck $0
  ${If} $0 = ${BST_CHECKED}
    ${NSD_Uncheck} $AurDeskCheck
  ${Else}
    ${NSD_Check} $AurDeskCheck
  ${EndIf}
FunctionEnd

Function AurToggleCli
  ${NSD_GetState} $AurCliCheck $0
  ${If} $0 = ${BST_CHECKED}
    ${NSD_Uncheck} $AurCliCheck
  ${Else}
    ${NSD_Check} $AurCliCheck
  ${EndIf}
FunctionEnd

Function AurChangeFolder
  nsDialogs::SelectFolderDialog "Choose where to install ${PRODUCTNAME}" $INSTDIR
  Pop $0
  ${If} $0 == error
    Return
  ${EndIf}
  ; Like the stock folder page: a folder that is not already ours gets one.
  ${GetFileName} $0 $1
  ${If} $1 != "${PRODUCTNAME}"
    StrCpy $0 "$0\${PRODUCTNAME}"
  ${EndIf}
  StrCpy $INSTDIR $0
  ${NSD_SetText} $AurPathEdit $INSTDIR
FunctionEnd

; Uninstall from the installer: confirm (it is destructive), then run the
; installed uninstaller in place and close.
Function AurUninstallClick
  MessageBox MB_YESNO|MB_ICONQUESTION "Uninstall ${PRODUCTNAME}?$\n$\nYour chats and settings stay in %LOCALAPPDATA%\AuroraIDE." IDYES +2
  Return
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  HideWindow
  ClearErrors
  ExecWait '$R1 _?=$4' $0
  ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}
  ${If} $0 = 0
    ; Run in place, the uninstaller cannot delete itself or its folder.
    Delete "$4\uninstall.exe"
    RMDir "$4"
    Quit
  ${EndIf}
  BringToFront
  ${If} $0 <> 1
    MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
  ${EndIf}
FunctionEnd

; 2. License Page (if defined) — Tauri's, kept for a license config.
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`) — Tauri's.
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 6. Start menu shortcut page — Tauri's (skipped unless a folder is set).
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; ── Page 2: Installing ───────────────────────────────────────────────────
; Moves on by itself when it finishes; on a failure it stays, with the
; reason in the status line and Cancel to close.
AutoCloseWindow true
!define MUI_INSTFILESPAGE_PROGRESSBAR smooth
!define MUI_INSTFILESPAGE_COLORS "F2F2F2 141414"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW AurInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

Function AurInstFilesShow
  FindWindow $AurDialog "#32770" "" $HWNDPARENT
  SetCtlColors $AurDialog ${AUR_TEXT} ${AUR_BG}
  !insertmacro AurMeasure $AurDialog

  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}

  ; Hide the log and its button; the status line says what is happening.
  GetDlgItem $0 $AurDialog 1016
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $AurDialog 1027
  ShowWindow $0 ${SW_HIDE}

  ; Progress: a 4px accent line on a dark track (themes off so colours apply).
  GetDlgItem $0 $AurDialog 1004
  !insertmacro AurDarkTheme $0 ""
  System::Call "user32::SetWindowLongW(p r0, i -20, i 0)"
  SendMessage $0 0x0409 0 ${AUR_ACCENT_BGR}
  SendMessage $0 0x2001 0 ${AUR_TRACK_BGR}
  !insertmacro AurPx $1 28
  !insertmacro AurPx $2 108
  IntOp $3 $AurW - 56
  !insertmacro AurPx $3 $3
  !insertmacro AurPx $4 4
  System::Call "user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x24)"

  GetDlgItem $0 $AurDialog 1006
  SetCtlColors $0 ${AUR_MUTED} ${AUR_BG}
  SendMessage $0 ${WM_SETFONT} $AurFontBody 1
  !insertmacro AurPx $2 122
  !insertmacro AurPx $4 20
  System::Call "user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x24)"

  ; The mark and the title, drawn onto the page directly.
  !insertmacro AurPx $1 28
  !insertmacro AurPx $2 26
  !insertmacro AurPx $3 48
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${AUR_ICON_STYLE}, i r1, i r2, i r3, i r3, p $AurDialog, p 0, p 0, p 0) p .r5'
  SetCtlColors $5 "" ${AUR_BG}
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r9'
  System::Call 'user32::LoadImageW(p r9, p 103, i 1, i r3, i r3, i 0) p .r8'
  SendMessage $5 ${STM_SETICON} $8 0

  !insertmacro AurPx $1 90
  !insertmacro AurPx $2 28
  IntOp $3 $AurW - 116
  !insertmacro AurPx $3 $3
  !insertmacro AurPx $4 28
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Installing ${PRODUCTNAME}", i 0x50000000, i r1, i r2, i r3, i r4, p $AurDialog, p 0, p 0, p 0) p .r5'
  SetCtlColors $5 ${AUR_TEXT} ${AUR_BG}
  SendMessage $5 ${WM_SETFONT} $AurFontTitle 1
  !insertmacro AurPx $2 58
  !insertmacro AurPx $4 18
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Version ${VERSION}", i 0x50000000, i r1, i r2, i r3, i r4, p $AurDialog, p 0, p 0, p 0) p .r5'
  SetCtlColors $5 ${AUR_MUTED} ${AUR_BG}
  SendMessage $5 ${WM_SETFONT} $AurFontBody 1

  ; Cancel, bottom right, dark — disabled while files copy, live on failure.
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  System::Call "*(i,i,i,i) p .r1"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r1)"
  System::Call "*$1(i, i, i .r2, i .r3)"
  System::Free $1
  !insertmacro AurPx $4 124
  IntOp $4 $2 - $4
  !insertmacro AurPx $5 50
  IntOp $5 $3 - $5
  !insertmacro AurPx $6 96
  !insertmacro AurPx $7 30
  System::Call "user32::SetWindowPos(p r0, p 0, i r4, i r5, i r6, i r7, i 0x14)"
FunctionEnd

; ── Page 3: Done ─────────────────────────────────────────────────────────
Page custom AurDonePage AurDoneLeave

Function AurDonePage
  Call SkipIfPassive
  StrCpy $AurOpen 1
  nsDialogs::Create 1018
  Pop $AurDialog
  ${If} $AurDialog == error
    Abort
  ${EndIf}
  SetCtlColors $AurDialog ${AUR_TEXT} ${AUR_BG}
  !insertmacro AurHideOuterButtons
  !insertmacro AurMeasure $AurDialog

  !insertmacro AurMark 28 26 48
  IntOp $5 $AurW - 116
  !insertmacro AurLabel $0 90 28 $5 28 "${PRODUCTNAME} is installed" ${AUR_TEXT} $AurFontTitle
  !insertmacro AurLabel $0 90 58 $5 18 "Version ${VERSION}" ${AUR_MUTED} $AurFontBody
  ${If} $AurAddCli = 1
    StrCpy $1 "Find it in the Start menu, or type aurora in a new terminal."
  ${Else}
    StrCpy $1 "Find it in the Start menu."
  ${EndIf}
  IntOp $5 $AurW - 56
  !insertmacro AurLabel $0 28 108 $5 40 $1 ${AUR_MUTED} $AurFontBody

  IntOp $5 $AurW - 248
  IntOp $6 $AurH - 50
  !insertmacro AurButton $0 $5 $6 96 30 "Close" 0 AurDoneClose
  IntOp $5 $AurW - 140
  !insertmacro AurButton $0 $5 $6 112 30 "Open ${PRODUCTNAME}" 1 AurNextClick

  nsDialogs::Show
FunctionEnd

Function AurDoneClose
  StrCpy $AurOpen 0
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AurDoneLeave
  ${If} $AurOpen = 1
    Call RunMainBinary
  ${EndIf}
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}

  ; Aurora: the terminal command follows the last choice made on the Install
  ; page (the updater shows no page and must not undo it); on by default.
  StrCpy $AurAddCli 1
  ClearErrors
  ReadRegDWORD $0 HKCU "${MANUPRODUCTKEY}" "AddCli"
  ${IfNot} ${Errors}
    StrCpy $AurAddCli $0
  ${EndIf}
  StrCpy $AurDesktop 0


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${ElseIf} $AurDesktop = 1
    ; Aurora: the Install page's "Create a desktop shortcut".
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
