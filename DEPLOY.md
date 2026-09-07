# Putting Xenon on a real host

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
