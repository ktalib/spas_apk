# =============================================================================
#  Which Android SDK is real?
# -----------------------------------------------------------------------------
#  check-build-env.ps1 reports the FIRST SDK path it finds, which is wrong when
#  ANDROID_HOME points at an empty directory while the real SDK lives elsewhere.
#  This lists every candidate and what is actually inside it, so you can point
#  ANDROID_HOME at the one that has the packages.
#
#  Run on the build machine:  .\find-android-sdk.ps1
# =============================================================================

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ""
Write-Host ("Machine: {0}    User: {1}" -f $env:COMPUTERNAME, $env:USERNAME) -ForegroundColor Cyan
Write-Host ("ANDROID_HOME     = {0}" -f $env:ANDROID_HOME)
Write-Host ("ANDROID_SDK_ROOT = {0}" -f $env:ANDROID_SDK_ROOT)
Write-Host ("JAVA_HOME        = {0}" -f $env:JAVA_HOME)
Write-Host ""

# Every place an Android SDK plausibly lives on Windows.
$candidates = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    "C:\Android\sdk",
    "C:\Android\android-sdk",
    "$env:LOCALAPPDATA\Android\Sdk",
    "$env:USERPROFILE\AppData\Local\Android\Sdk",
    "$env:ProgramFiles\Android\android-sdk",
    "${env:ProgramFiles(x86)}\Android\android-sdk"
)

# Plus any Sdk folder under C:\Users\*\AppData\Local\Android (other profiles -
# the first report showed the SDK under a DIFFERENT user than the one running).
Get-ChildItem 'C:\Users' -Directory | ForEach-Object {
    $candidates += (Join-Path $_.FullName 'AppData\Local\Android\Sdk')
}

$seen = @{}
Write-Host ("{0,-58} {1,-6} {2,-10} {3,-12} {4}" -f 'PATH', 'adb', 'platforms', 'build-tools', 'licences') -ForegroundColor DarkGray
Write-Host ("-" * 104)

foreach ($p in $candidates) {
    if (-not $p) { continue }
    if ($seen.ContainsKey($p.ToLower())) { continue }
    $seen[$p.ToLower()] = $true

    if (-not (Test-Path $p)) {
        Write-Host ("{0,-58} {1}" -f $p, '(does not exist)') -ForegroundColor DarkGray
        continue
    }

    $adb = 'no'
    if (Test-Path (Join-Path $p 'platform-tools\adb.exe')) { $adb = 'YES' }

    $plats = 0
    $platList = ''
    if (Test-Path (Join-Path $p 'platforms')) {
        $pl = Get-ChildItem (Join-Path $p 'platforms') -Directory
        $plats = $pl.Count
        $platList = ($pl | ForEach-Object { $_.Name }) -join ','
    }

    $bts = 0
    if (Test-Path (Join-Path $p 'build-tools')) {
        $bts = (Get-ChildItem (Join-Path $p 'build-tools') -Directory).Count
    }

    $lic = 0
    if (Test-Path (Join-Path $p 'licenses')) {
        $lic = (Get-ChildItem (Join-Path $p 'licenses') -File).Count
    }

    $usable = ($adb -eq 'YES' -and $plats -gt 0 -and $bts -gt 0 -and $lic -gt 0)
    if ($usable) { $color = 'Green' } else { $color = 'Yellow' }

    Write-Host ("{0,-58} {1,-6} {2,-10} {3,-12} {4}" -f $p, $adb, $plats, $bts, $lic) -ForegroundColor $color
    if ($platList) { Write-Host ("{0,-58} -> {1}" -f '', $platList) -ForegroundColor DarkGray }
}

Write-Host ("-" * 104)
Write-Host "The usable SDK is the GREEN row (adb=YES and all three counts > 0)." -ForegroundColor Cyan
Write-Host "Point ANDROID_HOME at it:" -ForegroundColor Cyan
Write-Host '    setx ANDROID_HOME "<that path>"' -ForegroundColor White
Write-Host "then close and reopen the terminal." -ForegroundColor Cyan
Write-Host ""
