<#
  Points xennoonnn.duckdns.org at 127.0.0.1 in the hosts file.

  It used to point at 192.168.1.81. That was this PC's DHCP address, and the
  router has since moved it to 192.168.1.74 - so the name resolved to a dead
  address and the whole site looked broken. Loopback cannot drift, and Caddy
  listens on 0.0.0.0, so it answers there with the same certificate.

  Other devices on the wifi still need the real LAN address; this only fixes
  this PC. Run as Administrator.
#>

$ErrorActionPreference = 'Stop'
$name  = 'xennoonnn.duckdns.org'
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated. Run PowerShell as Administrator." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}

$lines = Get-Content $hosts | Where-Object { $_ -notmatch [regex]::Escape($name) }
$lines += "127.0.0.1`t$name"
Set-Content -Path $hosts -Value $lines -Encoding ASCII
Clear-DnsClientCache
Write-Host "hosts: $name -> 127.0.0.1" -ForegroundColor Green

Write-Host ""
try {
  $r = Invoke-WebRequest -Uri "https://$name/healthz" -TimeoutSec 10 -UseBasicParsing
  Write-Host ("OK: https://$name responded " + $r.StatusCode) -ForegroundColor Green
  Write-Host "Chat and the portal should work now." -ForegroundColor Green
} catch {
  Write-Host ("Still failing: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Check Caddy is running: Get-Process caddy" -ForegroundColor Red
}
Read-Host "Press Enter to close"
