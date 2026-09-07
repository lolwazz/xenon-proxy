# xenon-proxy

Proxy backend for the Xenon portal.
Express + Ultraviolet + Scramjet + Wisp + Bare Server + bare-mux,
with epoxy and libcurl transports available.

## Run locally
    npm install
    npm start          # http://localhost:8080, local only

To make it reachable from anywhere, use `npm run go` instead - see below.

## Engines
Two proxy engines, switchable at runtime:

| Engine | Path | Notes |
|--------|------|-------|
| Ultraviolet | `/service/<encoded>` | default |
| Scramjet    | `/scramjet/<encoded>` | newer rewriter |

Pick one with the buttons on the page, or force it per request with
`?e=uv` / `?e=scramjet`. The choice is remembered in localStorage, and the
portal passes it automatically: `/?u=<url>&e=scramjet`.

## Routes
| Path | What |
|------|------|
| `/` | entry page; accepts `?u=<url>` and `?e=<engine>` |
| `/service/` | Ultraviolet-proxied content |
| `/scramjet/` | Scramjet-proxied content |
| `/wisp/` | Wisp WebSocket transport |
| `/bare/` | Bare server |
| `/healthz` | health check (the portal pings this) |
| `/uv/ /scram/ /baremux/ /baremod/ /epoxy/ /libcurl/` | client assets |

## Run it: `npm run go`

    npm install
    npm run go

That one command starts the server, opens a Cloudflare quick tunnel, waits
until the tunnel actually answers `/healthz`, and then writes the fresh URL
into the WordPress `proxy-endpoint` page. Visitors pick it up on their next
load; nobody edits anything by hand. It also watches both processes and
repeats the whole sequence if either dies. `go.bat` does the same on a
double-click.

### Why this exists
A quick tunnel gets a **new random hostname every time it starts**, but the
portal used to have the old hostname baked into a page that both the browser
and the WordPress host cache. After a restart the portal sat forever on
"opening transport", talking to a URL that no longer existed. The endpoint is
now looked up at runtime from one page, and that page is written by the
launcher.

The moving parts:

| Where | What |
|-------|------|
| `scripts/launch.mjs` | starts server + tunnel, health-checks, publishes, restarts on failure |
| WP page 171 (`proxy-endpoint`) | plain-text URL, the single source of truth |
| Portal (post 13) | fetches that page on load, every 45s, and on tab focus |
| Settings > Proxy endpoint | a manual override; set it and auto-discovery stops |

### Making the publish step automatic
Copy `.env.example` to `.env` and fill in an **application password** (not the
login password) from wp-admin > Users > Profile > Application Passwords.
Without it the launcher still runs - it just prints the URL for you to paste
into the `proxy-endpoint` page yourself.

### Limits of a quick tunnel
It only lives while your PC is on and `npm run go` is running, and the
hostname still changes on every restart (the launcher just makes that
invisible). For a URL that never changes, see below.

Do not bother with `localtunnel` or `untun`: localtunnel URLs die within
minutes (408 then 502), and untun exits immediately on Windows.

## A URL that never changes
Ranked by effort, all free, none of them Render:

1. **ngrok with a free static domain** - one reserved `*.ngrok-free.app`
   hostname on the free plan. Still needs your PC on, but the URL is fixed
   forever, so `proxy-endpoint` gets set once and never again.
   `ngrok http 8080 --url=your-name.ngrok-free.app`
2. **Hugging Face Spaces (Docker SDK)** - free, no card, permanent
   `*.hf.space` URL, and it runs when your PC does not. The `Dockerfile` here
   works as-is; expose port 7860 (`ENV PORT=7860`).
3. **Koyeb / Northflank free tier** - free, no card, permanent URL, always on.
4. **Cloudflare *named* tunnel** - permanent and fastest, but needs a
   Cloudflare account with a domain on their nameservers.
   `cloudflared tunnel create xenon` then route it to a hostname you own.
5. **Fly.io** - `fly launch --copy-config --now` (uses `fly.toml`). Requires a
   card on file even on the free allowance.

Whatever you pick, put the https URL in the `proxy-endpoint` page (or in
Settings > Proxy endpoint) once and stop running the launcher.

## Deploying
Needs a Node host with WebSocket support. It will NOT run on the WordPress
shared host, which is PHP. Configs for three options are included:

- **Docker** - `docker build -t xenon-proxy . && docker run -p 8080:8080 xenon-proxy`
  (also what Hugging Face Spaces, Koyeb and Northflank consume)
- **Fly.io** - `fly launch --copy-config --now` (uses `fly.toml`).
- **Render** - `render.yaml` is still here if you change your mind.

The host must give you an **https** URL: the portal is https and browsers block
mixed content. Then set **Settings > Proxy endpoint** on the site to that URL.
No code change needed.

## Four things that will bite you

**1. The header shim is required.**
bare-mux sends request headers as a plain object, but epoxy >=3.x and libcurl
>=2.0.3 iterate them with `for..of`, throwing `headers is not iterable`.
`setManualTransport` wraps the transport and converts to `Headers`. Do not
"simplify" it back to `setTransport`.

**2. Scramjet must be constructed lazily in the service worker.**
Building `ScramjetServiceWorker` at the top of `sw.js` opens its IndexedDB and
holds the connection, which blocks the page-side `ScramjetController.init()`
forever - it hangs rather than throwing. `sw.js` only constructs it when a
`/scramjet/` request actually arrives.

**3. The page must be controlled by the worker before scramjet.init().**
`init()` posts config to `navigator.serviceWorker.controller`. A freshly
registered worker often does not control the page that registered it, even
with `clients.claim()`, so the config never lands and `/scramjet/` URLs fall
through to Express as 404s. `index.html` does one guarded reload to fix this.

**4. `--use-system-ca` in the start script is load-bearing on Windows.**
Antivirus that scans HTTPS (AVG, ESET, Kaspersky, Bitdefender) replaces
certificates with its own root. Node only trusts it via the OS store. Without
the flag, every HTTPS fetch fails with `UnknownIssuer`. Diagnose with:

    node -e "const t=require('tls');const s=t.connect({host:'example.com',port:443,servername:'example.com',rejectUnauthorized:false},()=>{console.log(s.getPeerCertificate().issuer);s.end()})"

Related: the default transport is `bare`, so **Node** does the TLS rather than
WASM in the browser. `window.XENON_TRANSPORT` switches to `epoxy` or `libcurl`,
both of which carry their own CA stores and will fail behind such antivirus.

## Verified working
- Ultraviolet: `https://duckduckgo.com` loads fully through `/service/`.
- Scramjet: `https://example.com` loads fully through `/scramjet/`.
- Both verified from a cold start with caches, service workers and IndexedDB cleared.
- End to end from the live portal: typing a URL lands on a proxied page.
