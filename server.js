import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBareServer } from '@tomphttp/bare-server-node';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { isBlocked, stats as adStats } from './backend/adblock.js';
import { mountAuth, checkRequest, checkUpgrade, authEnabled } from './backend/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (p) => join(__dirname, 'node_modules', p);

const app = express();
app.use(compression());

// Allow the Xenon portal (or anything) to link into this proxy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

mountAuth(app);

// public/ is mounted FIRST so our own uv.config.js overrides the package default.
app.use(express.static(join(__dirname, 'public')));
app.use('/uv/',      express.static(pkg('@titaniumnetwork-dev/ultraviolet/dist')));
app.use('/scram/',   express.static(pkg('@mercuryworkshop/scramjet/dist')));
app.use('/baremux/', express.static(pkg('@mercuryworkshop/bare-mux/dist')));
app.use('/epoxy/',   express.static(pkg('@mercuryworkshop/epoxy-transport/dist')));
app.use('/libcurl/', express.static(pkg('@mercuryworkshop/libcurl-transport/dist')));
app.use('/baremod/', express.static(pkg('@mercuryworkshop/bare-as-module3/dist')));

// Ruffle: a WebAssembly Flash Player. Self-hosted so .swf games keep working
// no matter what happens to anyone else's servers - Flash itself was removed
// from every browser in 2020, so this is the only way to run them.
app.use('/ruffle/', express.static(pkg('@ruffle-rs/ruffle')));

// Wraps a .swf in a page that boots Ruffle and fills the screen. Served from
// /flash/<file>.swf so the games grid can link to it like any other game.
app.get('/flash/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^[\w.-]+\.swf$/i.test(file)) return res.status(400).send('bad file');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${file.replace(/\.swf$/i, '')}</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #player{width:100vw;height:100vh}
</style>
<script src="/ruffle/ruffle.js"></script>
</head><body>
<div id="player"></div>
<script>
  window.RufflePlayer = window.RufflePlayer || {};
  window.RufflePlayer.config = {
    autoplay: 'on',
    unmuteOverlay: 'hidden',
    letterbox: 'on',
    contextMenu: 'off',
    warnOnUnsupportedContent: false,
  };
  window.addEventListener('load', function () {
    var ruffle = window.RufflePlayer.newest();
    var player = ruffle.createPlayer();
    document.getElementById('player').appendChild(player);
    player.style.width = '100%';
    player.style.height = '100%';
    player.load('/g/flash/${encodeURIComponent(file)}');
  });
</script>
</body></html>`);
});

// Music API from PeteZahGames (github.com/PeteZah-Games/PeteZahGames), used
// with the author's permission. Provides /browse, /search, /track/:id,
// /play/:id, /stream/:id and a token-gated /media/:token audio proxy.
// Loaded lazily so a failure here cannot stop the proxy itself from starting.
try {
  const { default: musicRouter } = await import('./backend/routes/music.js');
  app.use('/api/music', musicRouter);
  // Mounted before the upstream router's own routes take over, so /find wins.
  const { default: findRouter } = await import('./backend/routes/music-find.js');
  app.use('/api/music/find', findRouter);
  const { default: statsRouter } = await import('./backend/routes/music-stats.js');
  app.use('/api/music/stats', statsRouter);
  const { default: presenceRouter } = await import('./backend/routes/presence.js');
  app.use('/api/presence', presenceRouter);
  console.log('music API mounted at /api/music');
} catch (err) {
  console.warn('music API unavailable: ' + (err && err.message ? err.message : err));
}

// Cover-art proxy, so the music page makes no direct requests to Google's or
// SoundCloud's CDNs. Allowlisted hosts only - this must not become an open
// image relay. The page falls back to the original URL if this fails.
const ART_HOSTS = [
  /(^|\.)ytimg\.com$/i,
  /(^|\.)ggpht\.com$/i,
  /(^|\.)mzstatic\.com$/i,
  /(^|\.)sndcdn\.com$/i,
  /(^|\.)scdn\.co$/i,
];
app.get('/img', async (req, res) => {
  let target;
  try { target = new URL(String(req.query.u || '')); } catch { return res.status(400).end(); }
  if (target.protocol !== 'https:') return res.status(400).end();
  if (!ART_HOSTS.some((re) => re.test(target.hostname))) return res.status(403).end();
  try {
    const upstream = await fetch(target.href, { headers: { 'User-Agent': FALLBACK_UA } });
    if (!upstream.ok) return res.status(upstream.status).end();
    const type = upstream.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return res.status(415).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

app.get('/adblock/stats', (req, res) => res.json(adStats));

app.get('/healthz', (req, res) => res.json({ ok: true, engine: 'ultraviolet' }));

// bare-server-node quietly applies a DEFAULT connection limiter of 10
// keep-alive requests per IP per 60s, then blocks that IP for another 60s and
// answers 429 "Too many keep-alive connections from this IP address". One
// ordinary page load makes far more requests than that, so every visitor trips
// it within seconds - this was the real cause of the proxy "not working" and of
// the flood of 500s on heavier sites. Raise the ceiling so it only catches a
// genuine runaway.
//
// It must be an OBJECT: createServer.js does `if (!init.connectionLimiter)`,
// so passing false, null or 0 silently restores the 10/minute default.
// Anything reaching here escaped both the proxy rewriter and the static
// mounts. Express's default handler answers with an HTML error page, so a
// proxied site's fetch(...).json() dies on
// `Unexpected token '<', "<!doctype "... is not valid JSON` - which reads like
// a Xenon bug but is really one un-rewritten request. Answer in JSON so the
// calling code just sees an ordinary 404.
app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    path: req.url,
    hint: 'This request reached the proxy origin directly instead of being rewritten.',
  });
});

const bare = createBareServer('/bare/', {
  connectionLimiter: {
    maxConnectionsPerIP: 20000,
    windowDuration: 60,
    blockDuration: 1,
  },
});
const server = createServer();

// Proxied requests arrive at the bare server with no User-Agent, because the
// browser strips it. Plenty of sites hard-block that: Wikipedia answers 403
// with "Please set a user-agent". Inject the real browser UA (falling back to
// a plausible one) when the bare request does not carry it.
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ensureUserAgent(req) {
  const raw = req.headers['x-bare-headers'];
  if (typeof raw !== 'string') return;          // split across x-bare-headers-N
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;
  for (const key of Object.keys(parsed)) {
    if (key.toLowerCase() === 'user-agent') return;
  }
  parsed['User-Agent'] = req.headers['user-agent'] || FALLBACK_UA;
  req.headers['x-bare-headers'] = JSON.stringify(parsed);
}

// The target of a bare request lives in x-bare-url, so ad hosts can be dropped
// here - before the machine ever contacts them. 204 rather than an error keeps
// the calling page happy.
function adBlocked(req, res) {
  const target = req.headers['x-bare-url'];
  if (typeof target !== 'string') return false;
  if (!isBlocked(target)) { adStats.allowed++; return false; }
  adStats.blocked++;
  res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
  res.end();
  return true;
}

server.on('request', (req, res) => {
  // Gate before anything else, including the bare server.
  if (!checkRequest(req, res)) return;
  if (bare.shouldRoute(req)) {
    if (adBlocked(req, res)) return;
    ensureUserAgent(req);
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

// A raw upgrade socket with no 'error' listener turns any socket failure into
// an uncaught exception that kills the whole server. That happens routinely
// here: a target site whose TLS handshake fails surfaces as
// `write EPROTO ... tlsv1 alert internal error ... alert number 80`, and one
// bad site would take every other user's session down with it.
server.on('upgrade', (req, socket, head) => {
  if (!checkUpgrade(req, socket)) return;
  socket.on('error', (err) => {
    console.warn('[upgrade socket] ' + (err && err.message ? err.message : err));
    socket.destroy();
  });
  if (bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
  if (req.url.startsWith('/wisp/')) return wisp.routeRequest(req, socket, head);
  socket.end();
});

// Malformed requests and TLS errors on the inbound side get the same
// treatment: log and drop the one connection, never the process.
server.on('clientError', (err, socket) => {
  console.warn('[client error] ' + (err && err.message ? err.message : err));
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request' + String.fromCharCode(13,10,13,10));
  else socket.destroy();
});

// Last resort. An unhandled socket error anywhere in the proxy stack should
// cost one request, not the server - the launcher would restart it, but every
// open tab would lose its session.
process.on('uncaughtException', (err) => {
  const msg = (err && err.message) ? err.message : String(err);
  if (/EPROTO|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|SSL|tlsv1|socket hang up/i.test(msg)) {
    console.warn('[recovered] ' + msg);
    return;
  }
  console.error('[fatal] ', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[unhandled rejection] ' + (reason && reason.message ? reason.message : reason));
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log('xenon-proxy listening on ' + port);
  console.log(authEnabled ? 'proxy is password protected' : 'WARNING: proxy is OPEN - set XENON_PASSWORD in .env');
});
