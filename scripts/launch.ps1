# Content Brief Studio 실행기 — 이미 떠 있으면 브라우저만 엽니다.
#
#   powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
#   ... -Stop      멈추기
#   ... -Restart   다시 시작
#   ... -NoBrowser 브라우저 안 열기
#
# 앱은 창 없이 백그라운드로 돕니다. 로그는 ~/.content-brief-studio/logs 에 남습니다.
# 이 파일은 UTF-8 BOM 으로 저장해야 합니다 — PowerShell 5.1 이 BOM 없는 한글을 ANSI 로 읽어 깨뜨립니다.
# 고친 뒤에는 node scripts/fix-encodings.mjs 로 BOM·CRLF 를 맞춥니다.

param([switch]$Stop, [switch]$Restart, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$DataDir = if ($env:CBS_DIR) { $env:CBS_DIR } else { Join-Path $env:USERPROFILE '.content-brief-studio' }
$LogDir  = Join-Path $DataDir 'logs'
$PidFile = Join-Path $DataDir 'app.pid'

# 설치 때 받아 둔 무설치 Node·git 이 있으면 쓴다. 시스템에 깔린 것이 먼저 잡히도록 뒤에 붙인다.
$runtime = Join-Path $DataDir 'runtime'
foreach ($d in @((Join-Path $runtime 'node'), (Join-Path $runtime 'git\cmd'), (Join-Path $env:USERPROFILE '.local\bin'))) {
  if ((Test-Path $d) -and ($env:Path -notlike "*$d*")) { $env:Path = "$env:Path;$d" }
}

$port = 4325
$cfg  = Join-Path $DataDir 'config.json'
if (Test-Path $cfg) {
  try { $p = (Get-Content $cfg -Raw | ConvertFrom-Json).port; if ($p) { $port = [int]$p } } catch {}
}
if ($env:CBS_PORT) { $port = [int]$env:CBS_PORT }
$url = "http://127.0.0.1:$port"

function Test-Up {
  try { $null = Invoke-WebRequest "$url/healthz" -TimeoutSec 2 -UseBasicParsing; $true } catch { $false }
}

function Stop-App {
  $stopped = $false
  if (Test-Path $PidFile) {
    $id = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $stopped = $true }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
  # pid 파일이 낡았을 수도 있으니 포트를 붙잡고 있는 쪽도 정리합니다.
  $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue; $stopped = $true }
  if ($stopped) { Write-Host "  멈췄습니다 (포트 $port)" } else { Write-Host '  실행 중이 아니었습니다' }
}

if ($Stop)    { Stop-App; return }
if ($Restart) { Stop-App; Start-Sleep -Seconds 2 }

if (Test-Up) {
  Write-Host "  이미 실행 중입니다 — $url"
  if (-not $NoBrowser) { Start-Process $url }
  return
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
# Start-Process -Environment 는 PowerShell 7 전용 — 여기서 정하고 자식이 물려받게 한다.
$env:CBS_NO_OPEN = '1'
$proc = Start-Process -FilePath 'node' `
  -ArgumentList @((Join-Path $Root 'src\index.js')) `
  -WorkingDirectory $Root `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'app.log') `
  -RedirectStandardError  (Join-Path $LogDir 'app.err.log')
$proc.Id | Set-Content $PidFile

for ($i = 0; $i -lt 40; $i++) {
  if (Test-Up) { break }
  Start-Sleep -Milliseconds 500
}

if (Test-Up) {
  Write-Host "  떴습니다 — $url"
  if (-not $NoBrowser) { Start-Process $url }
} else {
  $err = Join-Path $LogDir 'app.err.log'
  Write-Host '  실행에 실패했습니다. 로그를 확인해 주세요:' -ForegroundColor Yellow
  Write-Host "    $err"
  if (Test-Path $err) { Get-Content $err -Tail 15 }
  Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
  try { [System.Windows.MessageBox]::Show("Content Brief Studio 를 켜지 못했습니다.`n로그: $err", 'Content Brief Studio') | Out-Null } catch {}
}
