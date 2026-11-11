# Publishes the game library to Cloudflare R2, so the games are served by
# Cloudflare instead of this machine.
#
# Why R2 rather than Pages or S3:
#   - Pages refuses files over 25 MB and 25 of these are bigger.
#   - S3 charges for egress. At 2,000 visitors a day this library moves about
#     1.7 TB a month, which is roughly $150 on S3 and $0 on R2 - egress is
#     free, which is the entire reason to use it.
#   - 4 GB sits inside the 10 GB free tier, and 14,710 uploads sit inside the
#     1,000,000 free writes.
#
# Credentials come from .env and are never printed. Add these four lines:
#
#   R2_ACCOUNT_ID=...          (Cloudflare dashboard -> R2, top right)
#   R2_ACCESS_KEY_ID=...       (R2 -> Manage API tokens -> Create)
#   R2_SECRET_ACCESS_KEY=...
#   R2_BUCKET=xenon-games
#
# Usage:
#   powershell -File scripts/deploy-r2.ps1            upload changed files
#   powershell -File scripts/deploy-r2.ps1 -DryRun    show what would go
#   powershell -File scripts/deploy-r2.ps1 -Delete    also remove files no
#                                                     longer here

param(
  [switch]$DryRun,
  [switch]$Delete
)

$ErrorActionPreference = 'Stop'

# --- read .env without echoing anything ------------------------------------
$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envPath)) { Write-Output '  no .env found next to the project'; exit 1 }

$cfg = @{}
foreach ($line in Get-Content $envPath) {
  if ($line -match '^\s*#') { continue }
  if ($line -notmatch '=') { continue }
  $k = $line.Substring(0, $line.IndexOf('=')).Trim()
  $v = $line.Substring($line.IndexOf('=') + 1).Trim()
  $cfg[$k] = $v
}

$need = @('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET')
$missing = @()
foreach ($k in $need) { if (-not $cfg.ContainsKey($k) -or -not $cfg[$k]) { $missing += $k } }
if ($missing.Count -gt 0) {
  Write-Output ('  .env is missing: ' + ($missing -join ', '))
  Write-Output '  add them and run again - the values are never printed or sent anywhere but Cloudflare'
  exit 1
}

$endpoint = 'https://' + $cfg['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com'
$bucket = $cfg['R2_BUCKET']

# The CLI reads credentials from the environment of this process only.
$env:AWS_ACCESS_KEY_ID = $cfg['R2_ACCESS_KEY_ID']
$env:AWS_SECRET_ACCESS_KEY = $cfg['R2_SECRET_ACCESS_KEY']
$env:AWS_DEFAULT_REGION = 'auto'
$env:AWS_REQUEST_CHECKSUM_CALCULATION = 'when_required'
$env:AWS_RESPONSE_CHECKSUM_VALIDATION = 'when_required'

$src = Join-Path $PSScriptRoot '..\public\g'
if (-not (Test-Path $src)) { Write-Output '  public/g not found'; exit 1 }

$count = (Get-ChildItem $src -Recurse -File | Measure-Object).Count
$size = [math]::Round(((Get-ChildItem $src -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB), 2)
Write-Output ('  source: ' + $count + ' files, ' + $size + ' GB')
Write-Output ('  target: ' + $bucket + ' on R2')
Write-Output ''

$args = @('s3', 'sync', $src, ("s3://$bucket/g"), '--endpoint-url', $endpoint, '--no-progress')
if ($DryRun) { $args += '--dryrun' }
if ($Delete) { $args += '--delete' }

# Games are static and versioned by name, so they can be cached hard. The two
# manifests change whenever games are added, so they must not be.
$args += @('--exclude', 'index.json', '--exclude', 'covers.json',
           '--cache-control', 'public,max-age=31536000,immutable')

& aws @args
if ($LASTEXITCODE -ne 0) { Write-Output '  sync failed'; exit $LASTEXITCODE }

if (-not $DryRun) {
  foreach ($m in @('index.json', 'covers.json')) {
    $p = Join-Path $src $m
    if (-not (Test-Path $p)) { continue }
    & aws s3 cp $p ("s3://$bucket/g/$m") --endpoint-url $endpoint --no-progress `
        --content-type 'application/json' --cache-control 'public,max-age=60'
  }
}

Write-Output ''
Write-Output '  done.'
Write-Output '  next: in the R2 dashboard open the bucket -> Settings -> Public access,'
Write-Output '        enable it, and copy the public r2.dev address. That address plus'
Write-Output '        /g/index.json should load in a browser.'
