# xenon-proxy

Proxy backend for the Xenon portal. Express + Ultraviolet + Wisp + bare-mux,
with Scramjet and libcurl assets also served.

## Run locally
    npm install
    npm start          # http://localhost:8080

## Routes
| Path        | What                                        |
|-------------|---------------------------------------------|
| `/`         | entry page; accepts `?u=<url>`              |
| `/service/` | Ultraviolet-proxied content (service worker)|
| `/wisp/`    | Wisp WebSocket transport                    |
| `/bare/`    | Bare server                                 |
| `/healthz`  | health check                                |
| `/uv/ /scram/ /baremux/ /epoxy/ /libcurl/` | client assets |

## Deploying
Needs a Node host with WebSocket support — Render, Koyeb, Fly.io, or a VPS.
It will NOT run on the WordPress shared host (that's PHP).
Bind to `process.env.PORT`; the server already does.

Then in WordPress, set on the Portal page:
    window.PROXY_ENDPOINT = 'https://<your-host>';
    window.PROXY_PARAM    = 'u';

## Two things worth knowing

**1. The header shim in `public/index.html` is required.**
bare-mux sends request headers as a plain object, but epoxy >=3.x and libcurl
>=2.0.3 iterate them with `for..of`, which throws `headers is not iterable`.
`setManualTransport` wraps the transport and converts the object to `Headers`.
Don't "simplify" it back to `setTransport` or fetches break.

**2. Transports, and why 'bare' is the default.**
`window.XENON_TRANSPORT` picks the transport: `bare` (default), `epoxy`, or `libcurl`.

- `bare` routes fetches through this Node server, so **Node does the TLS**.
- `epoxy` / `libcurl` do TLS in the browser via WASM, using their own bundled
  CA stores.

That matters on a machine running AVG (or similar) HTTPS scanning: AVG replaces
certificates with its own root ("AVG Web/Mail Shield Root"). Node trusts it via
the system store (hence `--use-system-ca` in the start script), but epoxy and
libcurl do not, so they fail every HTTPS fetch with `UnknownIssuer`.
Use `bare` unless you have a reason not to. Diagnose with:

    node -e "const t=require('tls');const s=t.connect({host:'example.com',port:443,servername:'example.com',rejectUnauthorized:false},()=>{console.log(s.getPeerCertificate().issuer);s.end()})"

If the issuer is a real CA, HTTPS proxying will work.

## Verified working
`http://example.com` loads fully through `/service/` — browser -> bare-mux ->
epoxy -> wisp -> node -> internet and back.
