# clone-to-belimeai.ps1  (no gh CLI required)
#
# Assumes you have ALREADY created these two empty repos on GitHub:
#   https://github.com/belimeAI/app    (empty, no README)
#   https://github.com/belimeAI/brain  (empty, no README)
#   https://github.com/belimeAI/demo-repository   (already exists)
#
# Run from PowerShell:
#   cd C:\Users\vdzoo\Documents\GitHub\jarvis-app
#   powershell -ExecutionPolicy Bypass -File .\clone-to-belimeai.ps1

$ErrorActionPreference = 'Stop'
# Prevent PS 7.3+ from turning native-command stderr into terminating errors.
$PSNativeCommandUseErrorActionPreference = $false

# --- Paths (edit if different) ---
$GithubRoot = 'C:\Users\vdzoo\Documents\GitHub'
$JarvisApp  = Join-Path $GithubRoot 'jarvis-app'
$OwnJarvis  = Join-Path $GithubRoot 'own-jarvis'
$WorkDir    = Join-Path $env:TEMP   'belimeai-clone'
$Org        = 'belimeAI'
$DemoRepo   = 'demo-repository'

function Run {
    param([string]$Desc, [scriptblock]$Block)
    Write-Host "  -> $Desc" -ForegroundColor DarkGray
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "Failed: $Desc (exit $LASTEXITCODE)" }
}

function Has-Remote { param([string]$Name)
    # `git remote` (no args) lists remotes on stdout - no stderr involved.
    $list = & git remote 2>$null
    return @($list) -contains $Name
}

# Run a native command but ignore failures (used for best-effort cleanup).
function Try-Run {
    param([scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>&1 | Out-Null } catch { }
    $script:LASTEXITCODE = 0
    $ErrorActionPreference = $prev
}

function Push-To-BelimeAI {
    param([string]$LocalPath, [string]$RepoName)
    Write-Host ""
    Write-Host "=== Pushing $LocalPath -> $Org/$RepoName ===" -ForegroundColor Cyan
    if (-not (Test-Path (Join-Path $LocalPath '.git'))) {
        throw "Not a git repo: $LocalPath"
    }
    Push-Location $LocalPath
    try {
        if (Has-Remote 'belimeai') {
            Run "Replace stale 'belimeai' remote" { git remote remove belimeai }
        }
        Run "Add 'belimeai' remote" {
            git remote add belimeai "https://github.com/$Org/$RepoName.git"
        }
        Run "Push all branches"          { git push belimeai --all }
        Try-Run { git push belimeai --tags }
    } finally {
        Pop-Location
    }
}

# --- Pre-flight ---
Write-Host "Pre-flight..." -ForegroundColor Cyan
foreach ($p in @($JarvisApp, $OwnJarvis)) {
    if (-not (Test-Path (Join-Path $p '.git'))) {
        throw "Could not find git repo at: $p`nEdit the paths at the top of the script."
    }
}

# --- 1) Push the two repos to belimeAI ---
Push-To-BelimeAI -LocalPath $JarvisApp -RepoName 'app'
Push-To-BelimeAI -LocalPath $OwnJarvis -RepoName 'brain'

# --- 2) Set up demo-repository with submodules ---
Write-Host ""
Write-Host "=== Setting up $Org/$DemoRepo with submodules ===" -ForegroundColor Cyan
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir | Out-Null
Set-Location $WorkDir
Run "Clone $Org/$DemoRepo" {
    git clone "https://github.com/$Org/$DemoRepo.git"
}
Set-Location $DemoRepo

foreach ($name in @('app','brain')) {
    if (Test-Path $name) {
        Write-Host "  Removing pre-existing '$name'" -ForegroundColor Yellow
        Try-Run { git submodule deinit -f $name }
        Try-Run { git rm -rf $name }
        Remove-Item -Recurse -Force ".git\modules\$name" -ErrorAction SilentlyContinue
    }
}

Run "Add submodule app -> $Org/app" {
    git submodule add "https://github.com/$Org/app.git" app
}
Run "Add submodule brain -> $Org/brain" {
    git submodule add "https://github.com/$Org/brain.git" brain
}
Run "Commit submodules" {
    git commit -m "Add app and brain as submodules"
}
Run "Push to $Org/$DemoRepo" {
    git push origin HEAD
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  https://github.com/$Org/app"
Write-Host "  https://github.com/$Org/brain"
Write-Host "  https://github.com/$Org/$DemoRepo"
