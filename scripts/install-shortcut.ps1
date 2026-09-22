# 바탕화면·시작 메뉴 바로가기. -Uninstall 로 지웁니다.
# 콘솔 창이 뜨지 않게 wscript 로 app.vbs 를 거쳐 실행합니다.
# 이 파일은 UTF-8 BOM 으로 저장해야 합니다(고친 뒤 node scripts/fix-encodings.mjs).

param([switch]$Uninstall, [switch]$NoStartMenu)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Name = 'Content Brief Studio'
$targets = @((Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"))
if (-not $NoStartMenu) { $targets += Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$Name.lnk" }

if ($Uninstall) {
  foreach ($t in $targets) { if (Test-Path $t) { Remove-Item $t -Force; Write-Host "  지움: $t" } }
  return
}

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
  $lnk.Arguments        = "`"$Root\scripts\app.vbs`""
  $lnk.WorkingDirectory = $Root
  $lnk.Description      = 'TikTok 크리에이터 영상 가이드를 만들고 노션에 올리는 도구'
  $lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,70"
  $lnk.Save()
  Write-Host "  만듦: $t"
}
