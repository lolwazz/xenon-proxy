# xenon-proxy

Proxy backend for the Xenon portal.
Express + Ultraviolet + Scramjet + Wisp + Bare Server + bare-mux,
with epoxy and libcurl transports available.

## Run locally
    npm install
    npm start          # http://localhost:8080

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

## Deploying
Needs a Node host with WebSocket support. It will NOT run on the WordPress
shared host, which is PHP. Configs for three options are included:

- **Render** - push to GitHub, then New > Blueprint at the repo. `render.yaml` does the rest.
- **Fly.io** - `fly launch --copy-config --now` (uses `fly.toml`).
- **Docker** - `docker build -t xenon-proxy . && docker run -p 8080:8080 xenon-proxy`

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
