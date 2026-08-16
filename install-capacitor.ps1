# =============================================================================
#  SPAS APK - Capacitor install / Phase 1 shell scaffold
# -----------------------------------------------------------------------------
#  Run this IN THIS FOLDER (C:\wamp64\spas_apk).
#
#    1. Open PowerShell here
#    2. If it refuses to run:   Set-ExecutionPolicy -Scope Process Bypass
#    3. .\install-capacitor.ps1
#
#  What it does:  npm init, installs Capacitor 7 core/cli/android + the six
#  plugins the plan calls for, runs `cap init`, and creates a placeholder www/.
#  What it does NOT do:  `cap add android` or any Gradle build - those need the
#  Android SDK and belong on the build machine (DC-02). See PART B at the end.
#
#  Windows PowerShell 5.1 compatible (no ternary, no ??, no && chaining).
# =============================================================================

$ErrorActionPreference = 'Stop'

$AppName = 'SPAS Mobile'
$AppId   = 'ng.gov.kanostate.klaes.spas'   # reverse-DNS, must stay stable: it is
                                           # the Play/package identity forever
$WebDir  = 'www'

Set-Location $PSScriptRoot
Write-Host "Scaffolding Capacitor in $PSScriptRoot" -ForegroundColor Cyan

# --- 0. Guard: don't scaffold on top of an existing project ------------------
if (Test-Path (Join-Path $PSScriptRoot 'capacitor.config.json')) {
    Write-Host "capacitor.config.json already exists - stopping so nothing is overwritten." -ForegroundColor Yellow
    Write-Host "Delete it (and package.json / node_modules) first if you really want a clean scaffold."
    exit 1
}

# --- 1. package.json (its own, NOT the Laravel repo's) ----------------------
if (-not (Test-Path 'package.json')) {
    npm init -y | Out-Null
    Write-Host "[ OK ] package.json created" -ForegroundColor Green
}

# --- 2. Capacitor core + CLI + Android platform -----------------------------
npm install @capacitor/core@^7 @capacitor/cli@^7 @capacitor/android@^7

# --- 3. Plugins the plan requires (sections 4.2, 8, 9) -----------------------
#   sqlite      - on-device DB, the whole point of the offline design
#   preferences - Sanctum token storage (section 7)
#   network     - networkStatusChange drives the sync engine (section 6.1)
#   geolocation - native GPS, works offline (section 9)
#   camera+fs   - photo capture to app-private storage (section 8)
#   app         - resume event, another sync trigger
npm install `
    @capacitor-community/sqlite@^7 `
    @capacitor/preferences@^7 `
    @capacitor/network@^7 `
    @capacitor/geolocation@^7 `
    @capacitor/camera@^7 `
    @capacitor/filesystem@^7 `
    @capacitor/app@^7 `
    @capacitor/splash-screen@^7

# --- 4. cap init ------------------------------------------------------------
npx cap init "$AppName" "$AppId" --web-dir "$WebDir"

# --- 5. Placeholder web build folder ----------------------------------------
# Phase 1 replaces this with the exported mobile.blade.php UI. cap add android
# fails outright if webDir does not exist.
if (-not (Test-Path $WebDir)) { New-Item -ItemType Directory $WebDir | Out-Null }
if (-not (Test-Path (Join-Path $WebDir 'index.html'))) {
@'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SPAS Mobile</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
  <div style="text-align:center">
    <h1 style="margin:0 0 .5rem">SPAS Mobile</h1>
    <p style="color:#666;margin:0">Capacitor shell OK - Phase 1 placeholder.</p>
  </div>
</body>
'@ | Out-File -FilePath (Join-Path $WebDir 'index.html') -Encoding utf8
    Write-Host "[ OK ] www/index.html placeholder created" -ForegroundColor Green
}

# --- 6. .gitignore ----------------------------------------------------------
if (-not (Test-Path '.gitignore')) {
@'
node_modules/
android/
ios/
.gradle/
*.apk
*.aab
'@ | Out-File -FilePath '.gitignore' -Encoding utf8
}

Write-Host ""
Write-Host "Capacitor installed. Versions:" -ForegroundColor Cyan
npx cap --version
npm ls --depth=0

Write-Host ""
Write-Host "NEXT - on the BUILD MACHINE (DC-02) only:" -ForegroundColor Cyan
Write-Host "  npx cap add android"
Write-Host "  npx cap sync"
Write-Host "  cd android; .\gradlew assembleDebug"
Write-Host ""
