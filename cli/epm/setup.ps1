#Requires -Version 5.1
# EPM bootstrap — ensure Node.js >= 18 and git, then put `epm` on PATH.
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Min = 18
function Say($m) { Write-Host $m -ForegroundColor White }
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [xx] $m" -ForegroundColor Red; exit 1 }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function NodeMajor { try { [int]((node -v).TrimStart('v').Split('.')[0]) } catch { 0 } }

Say "EPM setup"

if ((NodeMajor) -ge $Min) {
  Ok "node $(node -v)"
} else {
  Warn "Node.js >= $Min not found - attempting to install"
  if (Have winget) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
  elseif (Have choco) { choco install nodejs-lts -y }
  else { Die "Install Node.js $Min+ from https://nodejs.org and re-run." }
  Warn "If Node was just installed, open a NEW terminal so PATH updates, then re-run setup."
}

if (Have git) {
  Ok "git $(git --version)"
} else {
  Warn "git not found - attempting to install"
  if (Have winget) { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements }
  elseif (Have choco) { choco install git -y }
  else { Warn "install git from https://git-scm.com (needed to clone/update the source)" }
}

$binDir = Join-Path $env:USERPROFILE '.epm\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir 'epm.cmd'
Set-Content -Path $shim -Encoding ASCII -Value "@echo off`r`nnode `"$Dir\bin\epm.js`" %*"
Ok "created $shim"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Warn "added $binDir to your user PATH - open a NEW terminal for it to take effect"
} else {
  Ok "$binDir already on PATH"
}

Say "Done. Open a new terminal and run:  epm doctor"
