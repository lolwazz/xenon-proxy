<#
  Renames this PC from OOZE to oozespcccc.

  Why: the gateway's port-forward dropdown lists devices by name only, and
  wifi MAC randomization has created 13 separate entries all called "ooze".
  There is no way to tell which one is live, so the forward keeps landing on
  a dead entry. After this rename and a restart, the PC re-registers with
  DHCP under a new name and becomes the only entry called oozespcccc.

  Caddy and the Xenon proxy both restart automatically on login via the
  Startup folder, so nothing needs starting by hand afterwards.
#>

$ErrorActionPreference = 'Stop'
$new = 'oozespcccc'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated. Run PowerShell as Administrator." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}

Write-Host ("current name: " + $env:COMPUTERNAME)

if ($env:COMPUTERNAME -eq $new) {
  Write-Host "Already renamed. Just restart if you have not yet." -ForegroundColor Yellow
} else {
  Rename-Computer -NewName $new -Force
  Write-Host ("renamed to " + $new + " - takes effect after restart") -ForegroundColor Green
}

Write-Host ""
Write-Host "After the restart:" -ForegroundColor Cyan
Write-Host "  1. Go to 192.168.1.254/cgi-bin/apphosting.ha"
Write-Host "  2. Delete the Xenon HTTPS row"
Write-Host "  3. Re-add it with Device = oozespcccc  (only one, no guessing)"
Write-Host ""
$go = Read-Host "Restart now? (y/n)"
if ($go -eq 'y') { Restart-Computer -Force } else { Write-Host "Restart when ready." }
