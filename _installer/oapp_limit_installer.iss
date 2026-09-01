#define MyAppName      "ระบบจำกัดนัดคลินิก"
#define MyAppNameEn    "oapp_limit"
#define MyAppVersion   "1.5.0"
#define MyAppPublisher "oapp_limit"
#define MyAppURL       "https://github.com/imhosxp4-byte/oapp_limit"
#ifndef SourceDir
  #define SourceDir    "d:\PROJECT-BMS\oapp_limit"
#endif

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\oapp_limit
DefaultGroupName={#MyAppName}
OutputDir={#SourceDir}\_output
OutputBaseFilename=Oapp-Limit-Full
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName} v{#MyAppVersion}
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
CloseApplicationsFilter=node.exe
DisableProgramGroupPage=yes

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Files]
; ── App source files ───────────────────────────────────────────────────────
Source: "{#SourceDir}\server.js";              DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\package.json";           DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\package-lock.json";      DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\static\*";               DestDir: "{app}\static";    Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\views\*";                DestDir: "{app}\views";     Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\templates\*";            DestDir: "{app}\templates"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\node_modules\*";         DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
; ── Launcher scripts ──────────────────────────────────────────────────────
Source: "{#SourceDir}\_installer\launcher.vbs";    DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\_installer\stop_server.vbs"; DestDir: "{app}"; Flags: ignoreversion
; ── Bundled Node.js MSI (offline install) ─────────────────────────────────
Source: "{#SourceDir}\_installer\node-setup.msi";  DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
; Start Menu
Name: "{group}\{#MyAppName}";                Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs""";     WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 14
Name: "{group}\หยุดเซิร์ฟเวอร์";            Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop_server.vbs""";  WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 131
Name: "{group}\ถอนการติดตั้ง";              Filename: "{uninstallexe}"
; Desktop shortcut (always created)
Name: "{autodesktop}\{#MyAppName}";          Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs""";     WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 14

[Run]
; Install Node.js silently only if NOT already installed
Filename: "msiexec.exe"; Parameters: "/i ""{tmp}\node-setup.msi"" /qn /norestart ADDLOCAL=ALL"; \
  Check: not NodeInstalled; StatusMsg: "กำลังติดตั้ง Node.js (offline)..."; \
  Flags: waituntilterminated skipifsilent

; Update system PATH so node is available immediately
Filename: "{sys}\cmd.exe"; Parameters: "/c setx PATH ""{pf}\nodejs;%PATH%"" /M"; \
  Flags: runhidden waituntilterminated; Check: not NodeInstalled

; Launch app after install
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"""; \
  Description: "เปิดโปรแกรมหลังติดตั้ง"; Flags: postinstall nowait skipifsilent unchecked

[UninstallRun]
; Stop server before uninstall
Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop_server.vbs"""; \
  Flags: runhidden waituntilterminated

[Code]
// ── ตรวจสอบว่าติดตั้ง Node.js แล้วหรือยัง ─────────────────────────────────
function NodeInstalled: Boolean;
var S: String;
begin
  Result :=
    FileExists(ExpandConstant('{pf}\nodejs\node.exe')) or
    FileExists(ExpandConstant('{pf32}\nodejs\node.exe')) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', S) or
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Node.js', 'InstallPath', S);
end;

// ── ถอนการติดตั้งเวอร์ชันเก่าอัตโนมัติก่อน install ใหม่ ──────────────────
function InitializeSetup: Boolean;
var
  UninstStr : String;
  ResultCode: Integer;
  Found     : Boolean;
begin
  Result := True;
  UninstStr := '';
  Found := False;

  // ค้นหาตาม registry 64-bit
  if RegQueryStringValue(HKLM,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}_is1',
      'UninstallString', UninstStr) then Found := True;

  // ถ้าไม่เจอ ลอง 32-bit path
  if not Found then
    if RegQueryStringValue(HKLM,
        'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}_is1',
        'UninstallString', UninstStr) then Found := True;

  if Found and (UninstStr <> '') then
  begin
    // หยุด server ก่อน
    Exec(ExpandConstant('{sys}\cmd.exe'),
         '/c taskkill /F /IM node.exe /T >nul 2>&1',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(800);
    // ถอนการติดตั้งเวอร์ชันเก่าแบบ silent
    Exec(RemoveQuotes(UninstStr),
         '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1200);
  end;
end;

// ── สร้าง default db_config.json ถ้ายังไม่มี ──────────────────────────────
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not FileExists(ExpandConstant('{app}\db_config.json')) then
      SaveStringToFile(ExpandConstant('{app}\db_config.json'),
        '{"active":"mysql","mysql":{"host":"localhost","port":3306,' +
        '"database":"","username":"","password":""},' +
        '"postgresql":{"host":"localhost","port":5432,' +
        '"database":"","username":"","password":""}}',
        False);
  end;
end;
