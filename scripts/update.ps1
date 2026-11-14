# =============================================================
#  update.ps1 - rebuild the library from 1.Guitar / 2.Piano /
#  3.Fingerstyle, bump the asset version and push to GitHub.
#
#  Double-click update.cmd instead of this file.
#  Optional switches:
#     -NoPush     build + commit locally, do not push
#     -Force      rebuild the encrypted bundle even if nothing changed
# =============================================================
param(
    [switch]$NoPush,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Step($text) { Write-Host ""; Write-Host ">> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   $text" -ForegroundColor DarkGray }
function Warn($text) { Write-Host "   $text" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  TABLATURE  -  library update" -ForegroundColor White
Write-Host "  $root" -ForegroundColor DarkGray

# -- 1. find python -------------------------------------------
Step "Looking for Python"
$python = $null
$pyArgs = @()
foreach ($candidate in @('python', 'py')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $python = $cmd.Source
        if ($candidate -eq 'py') { $pyArgs = @('-3') }
        break
    }
}
if (-not $python) {
    $bundled = 'C:\Users\12960\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\python\python.exe'
    if (Test-Path $bundled) {
        $python = $bundled
        $pyArgs = @()
    }
}
if (-not $python) {
    Warn "Python was not found. Install it from python.org and tick 'Add to PATH'."
    exit 1
}
Ok $python

$env:PYTHONIOENCODING = 'utf-8'

# -- 2. public shelves (1.Guitar) -----------------------------
Step "Building the guitar library and thumbnails"
& $python @pyArgs scripts/build_library.py
if ($LASTEXITCODE -ne 0) { Warn "build_library.py failed"; exit 1 }

# -- 3. locked shelves (2.Piano + 3.Fingerstyle) --------------
$lockedSources = @()
foreach ($folder in @('2.Piano', '3.Fingerstyle')) {
    if (Test-Path $folder) {
        $lockedSources += Get-ChildItem $folder -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @('.pdf', '.png', '.jpg', '.jpeg', '.webp') }
    }
}

$indexFile = 'secure/index.enc'
$needsSecure = $Force -or -not (Test-Path $indexFile)
if (-not $needsSecure -and $lockedSources) {
    $built = (Get-Item $indexFile).LastWriteTimeUtc
    $newest = ($lockedSources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
    if ($newest -gt $built) { $needsSecure = $true }
}

if ($needsSecure) {
    Step "Rendering and encrypting the locked shelves (about 30s)"
    & $python @pyArgs scripts/build_secure.py
    if ($LASTEXITCODE -ne 0) { Warn "build_secure.py failed"; exit 1 }

    Step "Encrypting (password: c)"
    node scripts/build_secure.mjs
    if ($LASTEXITCODE -ne 0) { Warn "build_secure.mjs failed"; exit 1 }
} else {
    Step "Locked shelves unchanged - skipping the encrypted rebuild"
}

# -- 4. anything to publish? ----------------------------------
Step "Checking for changes"
$dirty = git status --porcelain
if (-not $dirty) {
    Write-Host ""
    Write-Host "  Nothing new to publish." -ForegroundColor Green
    Write-Host ""
    exit 0
}

# -- 5. bump the asset version so browsers fetch new files ----
Step "Bumping asset version"
$html = Get-Content index.html -Raw
$next = ''
if ($html -match 'app\.js\?v=(\d+)') {
    $current = [int]$Matches[1]
    $next = [string]($current + 1)

    Get-ChildItem assets/js/*.js | ForEach-Object {
        $text = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
        $text = $text.Replace(".js?v=$current'", ".js?v=$next'").Replace("const BUILD = '$current'", "const BUILD = '$next'")
        [System.IO.File]::WriteAllText($_.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
    $html = $html.Replace("styles.css?v=$current", "styles.css?v=$next").Replace("app.js?v=$current", "app.js?v=$next")
    [System.IO.File]::WriteAllText((Resolve-Path index.html), $html, (New-Object System.Text.UTF8Encoding($false)))
    Ok "v$current -> v$next"
} else {
    Warn "Could not find a version number in index.html - leaving it alone"
}

# -- 6. commit and push ---------------------------------------
Step "Committing"
$summary = (git status --porcelain | Measure-Object).Count
git add -A
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
git commit -q -m "Update library $stamp (build $next)" | Out-Null
Ok "$summary file(s) committed"

if ($NoPush) {
    Write-Host ""
    Write-Host "  -NoPush: commit kept locally." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

Step "Pushing to GitHub"
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Warn "Push failed. The commit is saved locally - run 'git push origin main' later."
    exit 1
}

Write-Host ""
Write-Host "  Done. GitHub Pages rebuilds in about a minute." -ForegroundColor Green
Write-Host "  https://jaijaic.github.io/c.tabulature/" -ForegroundColor White
Write-Host ""
