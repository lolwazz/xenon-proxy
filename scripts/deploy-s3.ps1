# Publishes the games to an S3 bucket so they work at school without this PC
# running at all.
#
# The bucket MUST be in us-east-1. The address that gets through the filter is
# the path-style one:
#
#     https://s3.amazonaws.com/<bucket>/index.html
#
# and path-style on the plain s3.amazonaws.com host only resolves for
# us-east-1 buckets. A bucket in any other region has to be reached at
# <bucket>.s3.<region>.amazonaws.com, which is a different hostname and may not
# be allowed through.
#
# Credentials come from `aws configure`, which you run yourself - this script
# never sees or stores a key.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-s3.ps1 -Bucket your-bucket-name
#   ... -WhatIf     to see what would upload without uploading

param(
    [Parameter(Mandatory = $true)]
    [string]$Bucket,
    [string]$Region = "us-east-1",
    [switch]$WhatIf
)

$aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
if (-not (Test-Path $aws)) {
    $cmd = Get-Command aws -ErrorAction SilentlyContinue
    if ($cmd) { $aws = $cmd.Source } else {
        Write-Error "AWS CLI not found. Install it with: winget install Amazon.AWSCLI"
        exit 1
    }
}

$root = Split-Path $PSScriptRoot -Parent
$games = Join-Path $root "public\g"
$site  = Join-Path $root "s3site\index.html"

if (-not (Test-Path $games)) { Write-Error "missing $games"; exit 1 }
if (-not (Test-Path $site))  { Write-Error "missing $site";  exit 1 }

Write-Host ""
Write-Host "  bucket : s3://$Bucket  ($Region)"
Write-Host "  games  : $games"
Write-Host ""

# Check the credentials work before uploading 200 MB and failing at the end.
$who = & $aws sts get-caller-identity --output text 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Credentials are not set up. Run this first and enter your own keys:"
    Write-Host "     aws configure"
    Write-Host ""
    Write-Host "  aws said: $who"
    exit 1
}
Write-Host "  signed in as: $who"
Write-Host ""

$dry = ""
if ($WhatIf) { $dry = "--dryrun" }

# The games are immutable once published, so a long cache life keeps repeat
# visits instant and keeps the transfer bill near zero.
Write-Host "  uploading games (this is the slow part - about 200 MB)..."
& $aws s3 sync $games "s3://$Bucket/g/" `
    --region $Region `
    --cache-control "public,max-age=604800" `
    --exclude "*.json" `
    $dry

# The two manifests change whenever games are added, so they must not be
# cached for a week like the games are.
Write-Host ""
Write-Host "  uploading the game list..."
& $aws s3 cp (Join-Path $games "index.json") "s3://$Bucket/g/index.json" `
    --region $Region --content-type "application/json" `
    --cache-control "public,max-age=300" $dry
if (Test-Path (Join-Path $games "art.json")) {
    & $aws s3 cp (Join-Path $games "art.json") "s3://$Bucket/g/art.json" `
        --region $Region --content-type "application/json" `
        --cache-control "public,max-age=300" $dry
}

Write-Host ""
Write-Host "  uploading the front page..."
& $aws s3 cp $site "s3://$Bucket/index.html" `
    --region $Region --content-type "text/html; charset=utf-8" `
    --cache-control "public,max-age=300" $dry

if ($WhatIf) {
    Write-Host ""
    Write-Host "  dry run - nothing was uploaded"
    exit 0
}

Write-Host ""
Write-Host "  ============================================"
Write-Host "   Done. Your games are at:"
Write-Host ""
Write-Host "   https://s3.amazonaws.com/$Bucket/index.html"
Write-Host ""
Write-Host "   Works with this PC switched off."
Write-Host "  ============================================"
Write-Host ""
