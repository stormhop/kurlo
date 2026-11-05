Unicode true

!define REQUEST_EXECUTION_LEVEL "user"
!define WAILS_INSTALL_SCOPE "user"

!include /CHARSET=UTF8 "wails_tools.nsh"

!searchparse /noerrors "${INFO_PRODUCTVERSION}-" "" INFO_PRODUCTVERSION_NUMERIC "-"

VIProductVersion "${INFO_PRODUCTVERSION_NUMERIC}.0"
VIFileVersion    "${INFO_PRODUCTVERSION_NUMERIC}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

ManifestDPIAware true

!include "MUI2.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "assets\header.bmp"
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE_UNBITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEPAGE_TITLE "Welcome to Kurlo"
!define MUI_WELCOMEPAGE_TEXT "Your APIs. Your workspace.$\r$\n$\r$\nSet up your local-first API client in a few moments. No account required.$\r$\n$\r$\nKurlo installs for your Windows account. Click Next to choose where to install it."
!define MUI_FINISHPAGE_TITLE "Kurlo is ready"
!define MUI_FINISHPAGE_TEXT "You're all set to start sending requests.$\r$\n$\r$\nLaunch Kurlo now, or find it later in the Start menu."
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${INFO_PRODUCTNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"
InstallDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
ShowInstDetails hide
ShowUninstDetails hide

Function .onInit
    !insertmacro wails.checkArchitecture
FunctionEnd

Function RemoveMachineWideInstall
    SetRegView 64
    ReadRegStr $0 HKLM "${UNINST_KEY}" "UninstallString"
    ${If} $0 == ""
        Return
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION "An older copy of ${INFO_PRODUCTNAME} is installed for all users in Program Files. It cannot update itself, and this installer no longer needs administrator rights.$\r$\n$\r$\nRemove the old copy now? Windows will ask for permission once. Your requests, collections and settings are kept." /SD IDNO IDNO done
    StrCpy $1 $0 1
    ${If} $1 == '"'
        StrCpy $0 $0 -1 1
    ${EndIf}
    ExecShellWait "open" "$0" "/S"
    done:
FunctionEnd

Section
    !insertmacro wails.setShellContext

    Call RemoveMachineWideInstall

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    !insertmacro wails.files

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}"

    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
