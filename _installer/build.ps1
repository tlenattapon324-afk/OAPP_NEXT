<#
.SYNOPSIS
  Build Oapp-Limit-Full.exe installer
  - Clone source from GitHub (หรือใช้ local directory)
  - npm install --production
  - Download Node.js MSI (offline bundle)
  - Compile with Inno Setup 6

.PARAMETER FromGitHub
  Clone fresh from GitHub before building (default: use local source)

.PARAMETER Release
  Create GitHub Release after build (requires: gh auth login)

.EXAMPLE
  .\build.ps1                  # build จาก local source
  .\build.ps1 -FromGitHub      # clone จาก GitHub แล้ว build
  .\build.ps1 -FromGitHub -Release  # clone + build + create release
#>
param(
    [switch]$FromGitHub,
    [switch]$Release
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── Config ────────────────────────────────────────────────────────────────
$RepoUrl    = "https://github.com/imhosxp4-byte/oapp_limit.git"
$NodeVer    = "22.15.0"
$NodeMSI    = "node-v$NodeVer-x64.msi"
$NodeUrl    = "https://nodejs.org/dist/v$NodeVer/$NodeMSI"
$IsccExe    = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
$IssFile    = "$PSScriptRoot\oapp_limit_installer.iss"
$BuildTemp  = "$env:TEMP\oapp_limit_build_$([int](Get-Date -UFormat %s))"

function Write-Step($msg) { Write-Host "`n[+] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !! $msg" -ForegroundColor Yellow }

Write-Host "`n=====================================================" -ForegroundColor Magenta
Write-Host "  Oapp-Limit Installer Builder" -ForegroundColor Magenta
Write-Host "=====================================================`n" -ForegroundColor Magenta

# ── Step 1: SourceDir ─────────────────────────────────────────────────────
$SourceDir = (Resolve-Path "$PSScriptRoot\..").Path

if ($FromGitHub) {
    Write-Step "Cloning from GitHub → $BuildTemp"
    git clone $RepoUrl $BuildTemp
    $SourceDir = $BuildTemp
    Write-OK "Cloned to $SourceDir"
}

Write-OK "Source: $SourceDir"

# ── Step 2: npm install --production ──────────────────────────────────────
Write-Step "Installing npm packages (production only)"
$nodeModules = Join-Path $SourceDir "node_modules"

if (Test-Path $nodeModules) {
    Write-OK "node_modules already exists — skipping npm install"
} else {
    Push-Location $SourceDir
    npm install --production --no-audit --no-fund
    Pop-Location
    Write-OK "npm install complete"
}

# ── Step 3: Node.js MSI (offline bundle) ──────────────────────────────────
Write-Step "Checking Node.js MSI bundle"
$MsiPath = "$PSScriptRoot\node-setup.msi"

if (Test-Path $MsiPath) {
    $size = [math]::Round((Get-Item $MsiPath).Length / 1MB, 1)
    Write-OK "Found node-setup.msi ($size MB) — skipping download"
} else {
    Write-Warn "Downloading Node.js $NodeVer MSI from nodejs.org..."
    Invoke-WebRequest -Uri $NodeUrl -OutFile $MsiPath -UseBasicParsing
    Write-OK "Downloaded $NodeMSI"
    # Rename to node-setup.msi
    if ($NodeMSI -ne "node-setup.msi") {
        Copy-Item $NodeMSI $MsiPath -Force
        Remove-Item $NodeMSI
    }
}

# ── Step 4: Inno Setup compiler ────────────────────────────────────────────
Write-Step "Checking Inno Setup 6"
if (-not (Test-Path $IsccExe)) {
    Write-Warn "Inno Setup not found — installing silently..."
    $innoInst = "$PSScriptRoot\innosetup.exe"
    if (Test-Path $innoInst) {
        Start-Process $innoInst -ArgumentList "/VERYSILENT /NORESTART" -Wait
        Write-OK "Inno Setup installed"
    } else {
        Write-Error "innosetup.exe not found in _installer/"
    }
}
Write-OK "Inno Setup: $IsccExe"

# ── Step 5: Compile ────────────────────────────────────────────────────────
Write-Step "Compiling installer"
$OutputDir = Join-Path $SourceDir "_output"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$compileArgs = @(
    "/DSourceDir=$SourceDir",
    "/Q",
    $IssFile
)

Write-Host "    Running: ISCC.exe $($compileArgs -join ' ')" -ForegroundColor Gray
$result = & $IsccExe @compileArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup compilation failed (exit $LASTEXITCODE)"
}

$exePath = Join-Path $OutputDir "Oapp-Limit-Full.exe"
if (-not (Test-Path $exePath)) {
    Write-Error "Output EXE not found: $exePath"
}

$exeSize = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-OK "Built: $exePath ($exeSize MB)"

# ── Step 6: Copy to ตัวติดตั้ง/ ────────────────────────────────────────────
$destDir = Join-Path $SourceDir "ตัวติดตั้ง"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item $exePath (Join-Path $destDir "Oapp-Limit-Full.exe") -Force
Write-OK "Copied to ตัวติดตั้ง\"

# ── Step 7: GitHub Release (optional) ──────────────────────────────────────
if ($Release) {
    Write-Step "Creating GitHub Release v1.5.2"
    $tag  = "v1.5.2"
    $notes = @"
## สิ่งที่เพิ่มใหม่ใน v1.5.2

### ปรับปรุง
- เพิ่มไอคอนแอปแบบกำหนดเอง (การ์ดโค้งมนไล่สีน้ำเงิน-เขียวตามธีมแอป พร้อมกากบาททางการแพทย์สีขาว) แทนไอคอนเริ่มต้นของ Windows — ใช้กับ shortcut บน Desktop/Start Menu, ตัวติดตั้งเอง, และ favicon ของหน้าเว็บทุกหน้า

### การติดตั้ง
1. ดาวน์โหลด ``Oapp-Limit-Full.exe``
2. รันไฟล์ (ต้องการสิทธิ์ Admin)
3. ติดตั้งสำเร็จ — Double-click shortcut บน Desktop เพื่อเปิดโปรแกรม

> ติดตั้งได้แบบ **Offline** ทั้งหมด ไม่ต้องใช้ internet
"@
    gh release create $tag $exePath `
        --title "ระบบจำกัดนัดคลินิก v1.5.2" `
        --notes $notes
    Write-OK "Release created"
    gh release view $tag --json assets --jq '.assets[].browserDownloadUrl'
}

# ── Summary ────────────────────────────────────────────────────────────────
Write-Host "`n=====================================================" -ForegroundColor Magenta
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "  File: $exePath" -ForegroundColor White
Write-Host "  Size: $exeSize MB" -ForegroundColor White
if ($FromGitHub -and (Test-Path $BuildTemp)) {
    Remove-Item $BuildTemp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Temp build dir cleaned." -ForegroundColor Gray
}
Write-Host "=====================================================`n" -ForegroundColor Magenta
