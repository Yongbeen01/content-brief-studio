# Content Brief Studio 설치.
#
#   install.bat 을 두 번 누르거나, PowerShell 에 이 한 줄:
#   irm https://raw.githubusercontent.com/Yongbeen01/content-brief-studio/main/scripts/install.ps1 | iex
#
# 관리자 권한이 필요 없습니다. Node 와 git 이 없으면 설치 프로그램 대신 공식 무설치본(zip)을
# ~/.content-brief-studio/runtime 아래에 받습니다(MSI 는 UAC 창이 떠서 '원클릭'이 아니게 됩니다).
# Claude Code 가 없으면 공식 설치 스크립트로 설치합니다.
#
# 초안·노션 연결·팀 설정 코드는 %USERPROFILE%\.content-brief-studio 에 따로 있어 재설치해도 남습니다.
# 이 파일은 BOM 없이 저장해야 합니다 — irm | iex 는 BOM 을 명령으로 읽어 첫 줄에 오류를 냅니다.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'

$Repo    = if ($env:CBS_REPO) { $env:CBS_REPO } else { 'https://github.com/Yongbeen01/content-brief-studio.git' }
$Branch  = if ($env:CBS_BRANCH) { $env:CBS_BRANCH } else { 'main' }
$AppDir  = if ($env:CBS_APP_DIR) { $env:CBS_APP_DIR } else { Join-Path $env:LOCALAPPDATA 'content-brief-studio' }
$DataDir = if ($env:CBS_DIR) { $env:CBS_DIR } else { Join-Path $env:USERPROFILE '.content-brief-studio' }
$Runtime = Join-Path $DataDir 'runtime'

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Has($cmd)  { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Get-Zip($url, $dest) {
  $tmp = Join-Path $env:TEMP ("cbs-" + [guid]::NewGuid().ToString('N') + ".zip")
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  Content Brief Studio" -ForegroundColor White
Write-Host "  TikTok 크리에이터 영상 가이드를 만들고 노션에 올리는 도구" -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $DataDir, $Runtime | Out-Null

# 이미 돌고 있으면 먼저 멈춘다 — 실행 중인 node 가 앱 폴더를 잠가 clone 이 '액세스 거부'로 끝난다.
Step '실행 중인 앱 확인'
$stopped = $false
# 이미 깔려 있으면 그쪽 실행기에 맡긴다 — pid 파일과 포트를 같이 본다.
$oldLaunch = Join-Path $AppDir 'scriptslaunch.ps1'
if (Test-Path $oldLaunch) {
  try { & powershell -NoProfile -ExecutionPolicy Bypass -File $oldLaunch -Stop | Out-Null } catch {}
}
# 그래도 포트를 잡고 있으면 그 프로세스를 멈춘다.
# 명령줄만 보면 못 찾는다 — 실행기가 상대경로로 띄워 명령줄에 앱 폴더가 안 들어간다(실측).
$port = if ($env:CBS_PORT) { [int]$env:CBS_PORT } else { 4325 }
foreach ($owner in @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess)) {
  if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; $stopped = $true }
}
foreach ($p in (Get-Process node -ErrorAction SilentlyContinue)) {
  $cmdline = ''
  try { $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop).CommandLine } catch {}
  if ($cmdline -like "*$AppDir*") {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
}
if ($stopped) { Say '실행 중이던 앱을 멈췄습니다 (설치 후 다시 켭니다)'; Start-Sleep -Seconds 2 } else { Say '실행 중인 앱 없음' }

# ── 1. Node ──────────────────────────────────────────────────────────────────
Step 'Node 확인'
$nodeOk = $false
if (Has node) {
  $v = (node --version) -replace '^v', ''
  $nodeOk = [int]($v.Split('.')[0]) -ge 20
  if ($nodeOk) { Say "Node $v — 그대로 씁니다" } else { Warn "Node $v 는 너무 낮습니다 (20 이상 필요)" }
}
$nodeDir = Join-Path $Runtime 'node'
if (-not $nodeOk -and (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  $env:Path = "$nodeDir;$env:Path"
  $nodeOk = $true
  Say '무설치 Node 를 이미 받아뒀습니다'
}
if (-not $nodeOk) {
  Say '무설치 Node 를 받습니다 (설치 창이 뜨지 않습니다)…'
  $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $lts = $idx | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
  $stage = Join-Path $Runtime '_node_stage'
  Get-Zip "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-win-x64.zip" $stage
  $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item $inner.FullName $nodeDir
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  $env:Path = "$nodeDir;$env:Path"
  if (-not (Has node)) { throw 'Node 를 받았지만 실행되지 않습니다. https://nodejs.org 에서 LTS 를 설치한 뒤 다시 시도해 주세요.' }
  Say "Node $((node --version)) 준비됨 → $nodeDir"
}

# ── 2. git (자동 업데이트에 필요) ────────────────────────────────────────────
Step 'git 확인'
$gitDir = Join-Path $Runtime 'git'
$gitCmd = Join-Path $gitDir 'cmd'
if (Has git) {
  Say "$(git --version) — 그대로 씁니다"
} elseif (Test-Path (Join-Path $gitCmd 'git.exe')) {
  $env:Path = "$gitCmd;$env:Path"
  Say '무설치 git 을 이미 받아뒀습니다'
} else {
  try {
    Say '무설치 git 을 받습니다 (자동 업데이트에 필요합니다)…'
    $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' } | Select-Object -First 1
    Get-Zip $asset.browser_download_url $gitDir
    $env:Path = "$gitCmd;$env:Path"
    Say "$(git --version) 준비됨"
  } catch {
    Warn '받지 못했습니다 — 압축본으로 설치하고, 업데이트는 이 설치를 다시 실행하면 됩니다'
  }
}

# ── 3. Claude Code ───────────────────────────────────────────────────────────
Step 'Claude Code 확인'
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
if (Has claude) {
  Say "$((claude --version) -split ' ' | Select-Object -First 1) — 그대로 씁니다"
} else {
  Say 'Claude Code 를 설치합니다…'
  irm https://claude.ai/install.ps1 | iex
  if (-not (Has claude)) { throw 'Claude Code 설치를 확인하지 못했습니다. https://claude.com/claude-code 안내대로 설치한 뒤 다시 실행해 주세요.' }
}

# ── 4. 앱 받기 ───────────────────────────────────────────────────────────────
Step '앱 받기'
if ((Has git) -and (Test-Path (Join-Path $AppDir '.git'))) {
  Say '이미 있습니다 — 최신으로 맞춥니다'
  git -C $AppDir fetch --quiet origin $Branch
  git -C $AppDir reset --quiet --hard "origin/$Branch"
  Say $AppDir
} elseif (Has git) {
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  git clone --quiet --branch $Branch --depth 1 $Repo $AppDir
  Say $AppDir
} else {
  Warn 'git 이 없어 압축본으로 받습니다 (자동 업데이트는 꺼집니다)'
  $stage = Join-Path $env:TEMP 'content-brief-studio-stage'
  Get-Zip (($Repo -replace '\.git$', '') + "/archive/refs/heads/$Branch.zip") $stage
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  Move-Item (Get-ChildItem $stage -Directory | Select-Object -First 1).FullName $AppDir
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Say $AppDir
}

# irm | iex 로 도는 이 스크립트는 실행 정책을 안 타지만, 여기서 부르는 .ps1 '파일'은 탄다.
# 새 PC 기본값(Restricted)에서 막히므로 자식 스크립트는 별도 프로세스에 Bypass 를 명시한다.
function Invoke-Script($file, $extra = @()) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $AppDir $file)) + $extra
  & powershell.exe @a
}

# ── 5. 바로가기 ──────────────────────────────────────────────────────────────
Step '바로가기 만들기'
Invoke-Script 'scripts\install-shortcut.ps1'

# ── 6. Claude 로그인 ─────────────────────────────────────────────────────────
Step 'Claude 로그인 확인'
# auth status 는 JSON 을 준다. 판단이 안 서면 로그인을 권하는 쪽으로 기운다 — 안 된 사람이
# 그냥 넘어가면 앱이 조용히 안 된다.
$auth = (claude auth status 2>&1 | Out-String)
$loggedIn = $false
try { $loggedIn = [bool](($auth | ConvertFrom-Json).loggedIn) } catch { $loggedIn = $false }
if (-not $loggedIn) {
  Warn '아직 로그인되어 있지 않습니다.'
  Say '이 도구는 여러분의 Claude 구독으로 동작합니다 (API 키를 쓰지 않습니다).'
  Say '지금 브라우저 로그인 창을 엽니다 — 끝나면 이 창으로 돌아오세요.'
  claude auth login --claudeai
} else {
  Say '로그인되어 있습니다'
}

# ── 7. 실행 ──────────────────────────────────────────────────────────────────
Step '실행'
Invoke-Script 'scripts\launch.ps1'

Write-Host ""
Write-Host "  설치 끝났습니다." -ForegroundColor Green
Write-Host "  처음 한 번: 화면 오른쪽 위 [노션 설정]에 관리자에게 받은 팀 설정 코드를 넣어 주세요." -ForegroundColor DarkGray
Write-Host "  다음부터는 바탕화면의 Content Brief Studio 아이콘으로 여세요." -ForegroundColor DarkGray
Write-Host ""
