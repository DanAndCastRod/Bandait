; Inno Setup 6 script for the Bandait Leader Windows installer.
;
; Build (the release workflow .github/workflows/release.yml does this):
;   cd bandait-leader
;   python scripts\build_exe.py                       -> dist\BandaitLeader\
;   iscc /DMyAppVersion=2.1.0 scripts\installer.iss   -> dist\installer\BandaitLeader-Setup-2.1.0.exe
; /DMyAppVersion is required: the release workflow passes APP_VERSION, the
; same value build_exe.py stamps into BandaitLeader.exe (scripts\version.py).
;
; What it does:
; - Per-machine install in Program Files (needs admin), 64-bit only.
; - GPL-3.0 license page (repository LICENSE).
; - Start menu shortcut, optional desktop shortcut.
; - Windows Firewall: inbound TCP for BandaitLeader.exe on PRIVATE networks
;   only, so phones on the stage LAN can reach the leader. Removed on uninstall.
; - No downloads at install time. The installer is not signed: SmartScreen
;   shows "Windows protegio su PC" (Mas informacion > Ejecutar de todas formas).
; - User data (Documentos\Bandait: base de datos, grabaciones, registros) is
;   never touched, not even on uninstall.

#define MyAppName "Bandait Leader"
#define MyAppPublisher "Bandait"
#define MyAppURL "https://github.com/DanAndCastRod/Bandait"
#define MyAppExeName "BandaitLeader.exe"
#define MyAppUserModelID "Bandait.Leader"
#define MyFirewallRule "Bandait Leader"
#define BuildDir "..\dist\BandaitLeader"

#ifndef MyAppVersion
  #error Falta la version: iscc /DMyAppVersion=X.Y.Z scripts\installer.iss (python scripts\version.py la imprime)
#endif

[Setup]
AppId={{BANDAIT-LEADER-2026-0001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoDescription=Instalador de {#MyAppName}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=..\..\LICENSE
OutputDir=..\dist\installer
OutputBaseFilename=BandaitLeader-Setup-{#MyAppVersion}
SetupIconFile=..\resources\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
; Close a running leader (Restart Manager) before replacing its files.
CloseApplications=yes
RestartApplications=no
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
spanish.FirewallStatus=Abriendo el Firewall de Windows para los telefonos (solo redes privadas)...
english.FirewallStatus=Opening Windows Firewall for the phones (private networks only)...
spanish.FirewallDescription=Bandait Leader: telefonos de la banda en la red del escenario (TCP, solo redes privadas)
english.FirewallDescription=Bandait Leader: band phones on the stage network (TCP, private networks only)

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Upgrades: drop the previous PyInstaller bundle so no stale DLL can load.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; AppUserModelID: "{#MyAppUserModelID}"

[Run]
; Delete first so a reinstall or upgrade never leaves duplicate rules.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"" program=""{app}\{#MyAppExeName}"""; Flags: runhidden waituntilterminated; StatusMsg: "{cm:FirewallStatus}"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#MyFirewallRule}"" dir=in action=allow program=""{app}\{#MyAppExeName}"" enable=yes protocol=TCP profile=private description=""{cm:FirewallDescription}"""; Flags: runhidden waituntilterminated; StatusMsg: "{cm:FirewallStatus}"
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"" program=""{app}\{#MyAppExeName}"""; Flags: runhidden waituntilterminated; RunOnceId: "BandaitFirewallRule"
