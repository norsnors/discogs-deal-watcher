# install-shortcut.ps1 - put a "Discogs Deal Watcher" shortcut on the Desktop.
# Points straight at the bundled electron.exe (a GUI app, so no console window flashes) with the
# dashboard folder as the working dir, using our generated icon. Run:
#   powershell -ExecutionPolicy Bypass -File tools/install-shortcut.ps1
$ErrorActionPreference = 'Stop'

$root      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dashboard = Join-Path $root 'dashboard'
$electron  = Join-Path $dashboard 'node_modules\electron\dist\electron.exe'
$ico       = Join-Path $dashboard 'assets\icon.ico'

if (-not (Test-Path $electron)) {
  Write-Warning "electron.exe not found at $electron"
  Write-Warning "Run 'npm install' (or 'npm.cmd install') inside the dashboard folder first, then re-run this."
  exit 1
}
if (-not (Test-Path $ico)) {
  Write-Warning "icon.ico not found - generating it now."
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'make-icon.ps1')
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Discogs Deal Watcher.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = $electron
$lnk.Arguments        = '.'
$lnk.WorkingDirectory = $dashboard
$lnk.IconLocation     = "$ico,0"
$lnk.Description       = 'Discogs Deal Watcher - wantlist bargains'
$lnk.WindowStyle      = 1
$lnk.Save()

Write-Host "Created shortcut: $lnkPath"
