<#
  Adds the inbound firewall rule for port 8443.

  Caddy now listens on both 443 and 8443, because the AT&T gateway forwards
  outside-8443 to inside-8443 rather than translating it down to 443. The
  existing "Xenon HTTPS" rule only covers 443, so packets arriving on 8443
  were being dropped by Windows before Caddy saw them.
#>

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated. Run PowerShell as Administrator." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}

if (Get-NetFirewallRule -DisplayName 'Xenon HTTPS Alt' -ErrorAction SilentlyContinue) {
  Write-Host "rule already exists" -ForegroundColor Yellow
} else {
  New-NetFirewallRule -DisplayName 'Xenon HTTPS Alt' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 8443 -Profile Any | Out-Null
  Write-Host "opened inbound TCP 8443 (all profiles)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Open rules for Xenon:" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName 'Xenon*' |
  ForEach-Object {
    $p = $_ | Get-NetFirewallPortFilter
    "  {0}  port {1}  {2}" -f $_.DisplayName, $p.LocalPort, $_.Enabled
  }

Write-Host ""
try {
  $r = Invoke-WebRequest -Uri 'https://xennoonnn.duckdns.org:8443/healthz' -TimeoutSec 10 -UseBasicParsing
  Write-Host ("local :8443 responded " + $r.StatusCode) -ForegroundColor Green
} catch {
  Write-Host ("local :8443 failed - " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ""
Write-Host "Now retry https://xennoonnn.duckdns.org:8443 from your phone on cellular." -ForegroundColor Cyan
Read-Host "Press Enter to close"
