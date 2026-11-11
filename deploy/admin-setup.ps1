<#
  Opens the last door between the internet and Xenon.

  The AT&T gateway now forwards 443 to this machine, but Windows Firewall is
  set to BlockInbound, so connections from anywhere except this PC are dropped
  before Caddy ever sees them. Only an elevated process can change that.

  Also adds a hosts entry, so that on the home wifi this PC talks to Caddy
  directly instead of going out to the public IP and back in again - routers
  are unreliable at that turnaround (NAT hairpinning).
#>

$ErrorActionPreference = 'Stop'
$name = 'xennoonnn.duckdns.org'
$lan  = '192.168.1.81'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - right-click PowerShell and Run as Administrator." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

# 1. let the world reach port 443 on every profile, since Windows may classify
#    this wifi as Public rather than Private
if (Get-NetFirewallRule -DisplayName 'Xenon HTTPS' -ErrorAction SilentlyContinue) {
  Write-Host "firewall: rule already exists" -ForegroundColor Yellow
} else {
  New-NetFirewallRule -DisplayName 'Xenon HTTPS' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 443 -Profile Any | Out-Null
  Write-Host "firewall: opened inbound TCP 443 (all profiles)" -ForegroundColor Green
}

# 2. hosts entry so this PC skips the hairpin
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
if (Select-String -Path $hosts -Pattern ([regex]::Escape($name)) -Quiet) {
  Write-Host "hosts: already present" -ForegroundColor Yellow
} else {
  Add-Content -Path $hosts -Value ("`r`n" + $lan + "`t" + $name)
  Write-Host "hosts: added $lan -> $name" -ForegroundColor Green
}
Clear-DnsClientCache

# 3. prove it
Write-Host ""
try {
  $r = Invoke-WebRequest -Uri "https://$name/healthz" -TimeoutSec 10 -UseBasicParsing
  Write-Host ("OK: https://$name responded " + $r.StatusCode + " with a trusted certificate.") -ForegroundColor Green
} catch {
  Write-Host ("Local check failed: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Is Caddy running?  Get-Process caddy" -ForegroundColor Red
}

Write-Host ""
Write-Host "Done. Tell Claude to run the outside-world probe." -ForegroundColor Cyan
Read-Host "Press Enter to close"
