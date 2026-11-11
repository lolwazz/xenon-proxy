# Starts Caddy (TLS terminator for xennoonnn.duckdns.org) with the DuckDNS
# token pulled out of .env, so the ACME DNS challenge can renew the cert.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
    Set-Item -Path ("env:" + $Matches[1]) -Value $Matches[2].Trim()
  }
}

& (Join-Path $root 'vendor\caddy.exe') run --config (Join-Path $root 'Caddyfile') `
  *> (Join-Path $root 'caddy.log')
