# Putting Xenon on a real host

## Free: Cloudflare Pages + a named tunnel (current plan, 2026-09)

No card, no bill. The portal is static files on Cloudflare Pages (always up);
the proxy stays on this PC and is reached at a fixed address through a
Cloudflare Tunnel. When the PC is off the portal still loads and opens links
directly.

1. The domain's nameservers move from Porkbun to Cloudflare (free plan).
2. Build the portal for a separate proxy:

       node ../xenon-backup/build-site.mjs ../xenon-site --proxy https://proxy.xenonsschoollearning.online

3. Upload `../xenon-site` as a Cloudflare Pages project and give it the custom
   domains `xenonsschoollearning.online` and `www.xenonsschoollearning.online`.
   Live since 2026-09-23 as Pages project `xenon` (xenon-bji.pages.dev). To
   push site changes (classic Pages; wrangler is logged in with Pages-only
   scopes, so `--force` skips its Workers delegation):

       npx wrangler pages deploy ../xenon-site --project-name xenon --branch main --commit-dirty=true --force

4. Tunnel, once: `cloudflared tunnel login`, `cloudflared tunnel create xenon`,
   `cloudflared tunnel route dns xenon proxy.xenonsschoollearning.online`.
   Then in `.env`: `XENON_TUNNEL=xenon` and
   `XENON_PUBLIC_URL=https://proxy.xenonsschoollearning.online`, and
   `npm run go` runs that tunnel instead of a quick one (nothing to publish -
   the address is baked into the portal).

## AWS Lightsail (paid alternative)

Build the portal WITHOUT `--proxy` first (`node ../xenon-backup/build-site.mjs ../xenon-site`),
so the pages use the proxy on the same server under `/x`.

WordPress hosting lapsed, so the portal is now plain files in `../xenon-site`
(rebuilt from the recovered backup in `../xenon-backup`) and one Lightsail
server runs both the portal and this proxy behind Caddy.

1. Lightsail: Ubuntu 24.04, $7 plan, static IP attached, HTTPS allowed in the
   instance firewall. Download the default SSH key into Downloads.
2. From Git Bash in this folder:

       bash deploy/aws-deploy.sh <static-ip>

   First run uploads about 4.8 GB (the games folder is 4.3 GB). Later runs:
   `--no-games` (and `--no-samples`) skip the big folders.
3. It serves `https://<ip-with-dashes>.sslip.io/` straight away. Point the
   domain at the server in Porkbun (A records for `@` and `www` -> the static
   IP, replacing the old ones), then run the deploy again: once DNS resolves to
   the server it adds the domain and gets its certificate.

How the pieces fit (`deploy/Caddyfile.aws`): the portal is the site root, the
proxy's own page is `/x/`, and the proxy's assets and APIs keep their root
paths. The pages still ask `/wp-json/wp/v2/pages/171` where the proxy is -
Caddy answers with this server's `/x`. Chat reads
`/wp-json/wp/v2/comments?post=97` - the proxy answers that from
`backend/data/chat.json`.


Everything here is ready. This is the part that needs an account, which only
you can create.

## Why bother

The quick tunnel has four problems that hosting removes at once:

| Problem | Quick tunnel | Hosted |
|---|---|---|
| Your own network blocks it | yes (`*.trycloudflare.com` is NXDOMAIN on your router) | no |
| URL changes on every restart | yes | never |
| Dies when your PC sleeps | yes | no |
| Interstitial / IP exposure on free alternatives | yes | no |

That last one is why localtunnel and ngrok are not good enough here: both show
visitors a warning page first, which also means they cannot be embedded in the
`?u=` iframe on your own domain. A real host has no interstitial, so the
framed URL works.

## Hugging Face Spaces (free, no card)

1. Sign up at huggingface.co.
2. New > Space. SDK: **Docker** (blank template). Visibility: Public.
3. Upload every file in this folder **except** `node_modules/`, `.env`,
   and `launcher.log`.
4. It builds and serves on `https://<user>-<space>.hf.space`. That URL never
   changes.

Then, once:

    wp-admin -> Pages -> proxy-endpoint -> paste that URL -> Update

and stop running `npm run go` entirely. The launcher, the tunnel, the
self-publishing and the DNS workaround all become unnecessary.

Free Spaces sleep after inactivity and wake on the next request, so the first
hit after a quiet spell is slow. Koyeb and Northflank have free tiers that
stay awake if that bothers you; the same Dockerfile works on both.

## Keeping the tunnel as a fallback

`npm run go` still works and still publishes to page 171. If you set the
`proxy-endpoint` page manually to a hosted URL, do not run the launcher -
it would overwrite the page on its next start.
