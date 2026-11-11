# Serves the whole site (portal + proxy) from this PC on http://localhost:8090,
# for the tunnel's site.xenonsschoollearning.online address - the origin a CDN
# like Gcore sits in front of. Same routing as the one-server AWS layout
# (deploy/Caddyfile.aws); the tunnel does the HTTPS, so this is plain HTTP.
#
# The portal files come from ..\xenon-site-local, built with:
#   node ..\xenon-backup\build-site.mjs ..\xenon-site-local
$root = Split-Path -Parent $PSScriptRoot
$env:XENON_SITES = 'http://:8090'
$env:XENON_ROOT  = (Resolve-Path (Join-Path $root '..\xenon-site-local')).Path
$env:XENON_LOG   = Join-Path $root 'site-local.log'
$cfg = Join-Path $root 'deploy\Caddyfile.local'
@"
{
	admin localhost:2020
	auto_https off
}

"@ + (Get-Content (Join-Path $root 'deploy\Caddyfile.aws') -Raw) | Set-Content -Encoding utf8 $cfg
& (Join-Path $root 'vendor\caddy.exe') run --config $cfg --adapter caddyfile *> (Join-Path $root 'site-local.out.log')
