/* Must be first: every outgoing lookup goes through public DNS (see the file). */
import './backend/dns-fallback.js';
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { join, dirname, resolve, sep } from 'node:path';
import { existsSync, statSync, readFile } from 'node:fs';
import { withWatch } from './backend/watch-tag.js';
import { unblockText, unblockTarget } from './backend/cdn-unblock.js';
import { fileURLToPath } from 'node:url';
import { froggy } from './froggy.mjs';
import { createBareServer } from '@tomphttp/bare-server-node';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { isBlocked, stats as adStats } from './backend/adblock.js';
import { mountAuth, checkRequest, checkUpgrade, authEnabled } from './backend/auth.js';
import chatRouter, { commentsFeed, MEDIA_DIR as CHAT_MEDIA } from './backend/routes/chat.js';
import aiRouter from './backend/routes/ai.js';
import xenonRouter from './backend/routes/xenon.js';
import xeunesRouter from './backend/routes/xeunes.js';
import suggestRouter from './backend/routes/suggest.js';
import bookmarkletsRouter from './backend/routes/bookmarklets.js';
import { isVoiceRequest, handleVoiceUpgrade } from './backend/routes/voice.js';
import { isWatchRequest, handleWatchUpgrade, watchStats } from './backend/routes/watch.js';
import { asleep as vmAsleep, vmPowerStats } from './backend/vm-power.js';
import { mountStudioCollab, isStudioCollab, handleStudioUpgrade } from './backend/routes/studio-collab.js';
import { adminPage, adminApi, siteNotice } from './backend/routes/admin.js';
import clipsRouter, { clipPage, CLIP_DIR } from './backend/routes/clips.js';
import { duckEnabled, updateDuckDns } from './scripts/duckdns.mjs';
import { mountVmLock } from './backend/vm-lock.js';
import { isBridgeRequest, handleBridgeUpgrade, isControlRequest, handleControlUpgrade, probe as probePc, seatState, claimSeat } from './backend/routes/pc-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (p) => join(__dirname, 'node_modules', p);

const app = express();
app.use(compression());

// Allow the Xenon portal (or anything) to link into this proxy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  /* The portal is hosted separately, so its JSON POSTs (chat, presence) are
     cross-origin and the browser checks with a preflight first. Without an
     answer naming Content-Type, the POST never leaves the browser. */
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

mountAuth(app);

/* The game lists (index.json, popular.json, art.json...) are data for the
   games pages. Opened as a page - a tab or a game frame landing on one -
   they showed as a raw wall of JSON. Browsers say what a request is for in
   Sec-Fetch-Dest, so a page load gets a way back instead; fetch() still
   gets the JSON. */
app.get(/^\/g\/[^/]+\.json$/, (req, res, next) => {
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== 'document' && dest !== 'iframe') return next();
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xenon games</title>
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0b0618;color:#f3ecff;font:15px system-ui,sans-serif;text-align:center}
div{padding:24px}h1{font-size:1.3rem;margin:0 0 .5rem}p{margin:0 0 1.2rem;color:rgba(233,213,255,.65);font-size:.85rem}
button{border:0;border-radius:999px;padding:.7rem 1.4rem;font:700 .8rem system-ui;color:#fff;background:linear-gradient(135deg,#c084fc,#8b5cf6 55%,#ec4899);cursor:pointer}</style>
<div><h1>That's the game list, not a game</h1><p>Pick a game from the Games page.</p>
<button onclick="history.length>1?history.back():location.replace('/')">Go back</button></div>`);
});

// Shared clips and avatars, both written under data/ by their routers.
app.use('/api/clips', clipsRouter);
/* Studio rooms: live collaboration on one project (backend/routes/studio-collab.js). */
mountStudioCollab(app);
app.get('/clip/:cid', clipPage);
// Private, so Cloudflare keeps no copy: a deleted clip has to stop loading.
app.use('/clipfiles', express.static(CLIP_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=86400'),
}));
app.use('/avatars', express.static(join(__dirname, 'data', 'avatars'), { maxAge: '30d', immutable: true }));
/* Pictures sent in chat, named by their own hash, so they never change. */
app.use('/chatmedia', express.static(CHAT_MEDIA, {
  maxAge: '365d', immutable: true,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// Retro Bowl Modded: 1xretro.pages.dev, fetched by this server so the
// browser only ever talks to the proxy. The game list opens
// /g/retrobowlmodded.html; its files load from /g/retrobowlmodded/.
const RETRO = 'https://1xretro.pages.dev/';
const retroCache = new Map();
app.get(['/g/retrobowlmodded.html', /^\/g\/retrobowlmodded\/(.*)$/], async (req, res) => {
  const rel = req.params[0] ? String(req.params[0]).replace(/\.\.+/g, '') : '';
  const hit = retroCache.get(rel);
  try {
    let entry = hit;
    if (!entry) {
      const r = await fetch(RETRO + rel, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return res.status(r.status).end();
      let body = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') || 'application/octet-stream';
      if (!rel) body = Buffer.from(body.toString('utf8').replace(/<head>/i, '<head><base href="/g/retrobowlmodded/">'));
      entry = { type, body };
      if (body.length < 30 * 1024 * 1024) retroCache.set(rel, entry);
    }
    res.set({ 'Content-Type': entry.type, 'Cache-Control': 'public, max-age=86400' });
    res.end(entry.body);
  } catch {
    res.status(502).end();
  }
});

// froggy.* hosts get the green Froggy skin of the proxy page (froggy.mjs).
app.use(froggy(join(__dirname, 'public')));

// The service worker is never cached, at Cloudflare or in the browser: a
// stale copy that no longer matches the engines it imports is exactly the
// "ServiceWorker script evaluation failed" a fix would otherwise take hours
// to clear.
/* Both workers are always fetched fresh: a fix to either has to reach every
   Chromebook at once. sw-lite.js is the Ultraviolet-only fallback browser.js
   registers when sw.js fails to start. */
for (const name of ['sw.js', 'sw-lite.js']) {
  app.get('/' + name, (req, res) => {
    res.sendFile(join(__dirname, 'public', name), {
      cacheControl: false,
      headers: { 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Content-Type': 'application/javascript; charset=UTF-8' },
    });
  });
}

/* "Watch me play": game pages served from here (the fallback when the games
   site is blocked) get the same xn-watch.js the games site adds at build. */
const GAMES_DIR = join(__dirname, 'public', 'g');
app.get('/xn-watch.js', (req, res) => {
  res.sendFile(join(__dirname, 'scripts', 'games-pages', 'xn-watch.js'), { maxAge: '1h' });
});
app.get(/^\/g\/.+\.html?$/i, (req, res, next) => {
  let file;
  try { file = resolve(GAMES_DIR, '.' + decodeURIComponent(req.path.slice(2))); } catch { return next(); }
  if (!file.startsWith(GAMES_DIR + sep)) return next();
  readFile(file, 'latin1', (err, s) => {
    if (err) return next();
    res.type('html');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Access-Control-Allow-Origin', '*');
    res.end(Buffer.from(withWatch(s), 'latin1'));
  });
});

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
// Devtools the browser shell injects into a proxied page (Tools > Dev tools).
app.use('/eruda/', express.static(pkg('eruda'), { maxAge: '7d' }));

// Wraps a .swf in a page that boots Ruffle and fills the screen. Served from
// /flash/<file>.swf so the games grid can link to it like any other game.
app.get('/flash/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!/^[\w.-]+\.swf$/i.test(file)) return res.status(400).send('bad file');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><script src="/xn-watch.js" async></script><title>${file.replace(/\.swf$/i, '')}</title>
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
  // Wikipedia game art. Proxying it keeps the portal from hotlinking
  // upload.wikimedia.org on every tile, and caches it like the rest.
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)wikipedia\.org$/i,
  // Site icons for the portal tiles and the proxy browser's tabs.
  /^icons\.duckduckgo\.com$/i,
  // Covers for the web games (g/web.json) from the two catalogs they come from.
  /^img\.gamedistribution\.com$/i,
  /^img\.gamemonetize\.com$/i,
  // Chat's /imagine pictures: AI sites are a common school block, so they
  // come through here instead of straight from pollinations.ai.
  /^image\.pollinations\.ai$/i,
  // Xeunes: TIDAL's cover art (school filters block tidal.com).
  /^resources\.tidal\.com$/i,
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

// Game CDNs. A large part of the imported library is not hosted here at all:
// the page is a stub whose <base href> points at jsDelivr or githack, so every
// asset of that game comes from a domain the school filter judges separately,
// and a blocked CDN means a black screen.
//
// Relaying those through this origin means the browser only ever talks to one
// host. Allowlisted like /img, for the same reason - this must not turn into an
// open relay - and limited to the hosts the library actually references.
//
// Shape is /cdn/<host>/<path>, so a base href rewrites by prefix alone and
// every relative url inside the game keeps working untouched.
const GAME_CDNS = [
  /^cdn\.jsdelivr\.net$/i,
  /^(raw|bb)cdn\.githack\.com$/i,
  /^cdn\.statically\.io$/i,
  /^raw\.githubusercontent\.com$/i,
];
app.use('/cdn', async (req, res) => {
  const rest = String(req.url || '').replace(/^\/+/, '');
  if (!rest) return res.status(400).end();
  const slash = rest.indexOf('/');
  if (slash < 1) return res.status(400).end();
  const host = rest.slice(0, slash);
  if (!GAME_CDNS.some((re) => re.test(host))) return res.status(403).end();

  let target;
  try { target = new URL(unblockTarget('https://' + rest)); } catch { return res.status(400).end(); }

  try {
    const upstream = await fetch(target.href, {
      headers: { 'User-Agent': FALLBACK_UA },
      redirect: 'follow',
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    // raw.githubusercontent labels everything text/plain. A classic script
    // survives that, but WebAssembly.instantiateStreaming refuses anything
    // that is not application/wasm, so the type is named from the extension
    // whenever the upstream one is the generic fallback.
    const CDN_TYPES = {
      js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
      wasm: 'application/wasm', css: 'text/css', html: 'text/html',
      data: 'application/octet-stream', unityweb: 'application/octet-stream',
      mem: 'application/octet-stream', symbols: 'application/octet-stream',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    };
    const ext = (target.pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
    const upstreamType = upstream.headers.get('content-type') || '';
    const guessed = ext ? CDN_TYPES[ext.toLowerCase()] : null;
    const vague = !upstreamType || /^text\/plain/i.test(upstreamType);
    const type = (vague && guessed) ? guessed : upstreamType;
    if (type) res.setHeader('Content-Type', type);
    // Deliberately not forwarding content-encoding. fetch has already
    // decompressed the body by the time we see it, so repeating the upstream
    // header tells the client to decode bytes that are no longer encoded - it
    // gives up and the response arrives empty.
    // These urls carry a commit hash or a version, so they never change.
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    /* Scripts, pages and styles can ask jsDelivr for more files from a
       blocked user; send those through here too (backend/cdn-unblock.js). */
    if (/javascript|json|css|html/i.test(type)) {
      return res.end(Buffer.from(unblockText(Buffer.from(await upstream.arrayBuffer()).toString('latin1')), 'latin1'));
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// Express has no mapping for .cur, so it ships as octet-stream. Chrome will
// usually sniff it, but naming the type removes the guesswork.
app.use('/cursors', (req, res, next) => {
  if (req.path.toLowerCase().endsWith('.cur')) res.type('image/x-icon');
  next();
});

/* Mounted outside the music try/catch: chat must not depend on the music
   API importing cleanly. */
app.use('/api/chat', chatRouter);
/* Notifications, Live TV, events, premium, tags, leaderboard (routes/xenon.js). */
app.use('/api/x', xenonRouter);
/* Xeunes, the portal's music app: song matching, audio and the TIDAL relay
   (routes/xeunes.js). */
app.use('/api/xe', xeunesRouter);
app.use('/api/bookmarklets', bookmarkletsRouter);
/* Admin panel: reachable only at /admin/<ADMIN_URL_TOKEN>; anything else
   falls through to the ordinary 404. See backend/routes/admin.js. */
app.get('/admin/:token', adminPage);
app.use('/api/admin', adminApi);
app.get('/api/site/notice', siteNotice);
/* The AI bot. Keys live in .env and never reach the browser. */
app.use('/api/ai', aiRouter);
/* The chat page still reads its messages from the WordPress comments URL. */
app.get('/wp-json/wp/v2/comments', commentsFeed);
/* Mounted twice. /api/ac is the one the page calls: some content blockers
   carry rules for search-suggestion paths, and "ac" is nondescript enough
   to sidestep that. This is a precaution, not a diagnosis - I have not
   seen a filter block the old name. /api/suggest stays for cached pages. */
/* The VM page asks this before opening a socket, so a machine that is off
   reads as off instead of as a broken page. */
mountVmLock(app);
app.get('/api/pc/status', async (req, res) => {
  const vm = String(req.query.vm || 'win10');
  const up = await probePc(vm);
  /* A sleeping VM counts as available: opening it boots it (vm-power.js). */
  const sleeping = !up && vmAsleep(vm);
  res.json({ running: up || sleeping, asleep: sleeping });
});

/* The Linux seats as one machine: which are up, which are taken. Every open
   VM page polls this, so the probes are shared for a few seconds rather
   than four new connections into the guest per visitor per poll. */
const SEAT_IDS = ['seat1', 'seat2', 'seat3', 'seat4'];
let seatProbe = { at: 0, up: [], pending: null };
function seatsUp() {
  /* The Linux VM asleep: every seat is free, and opening one boots it. */
  if (vmAsleep('seat1')) return Promise.resolve(SEAT_IDS.slice());
  if (Date.now() - seatProbe.at < 5000) return Promise.resolve(seatProbe.up);
  if (seatProbe.pending) return seatProbe.pending;
  seatProbe.pending = Promise.all(SEAT_IDS.map((s) => probePc(s))).then((r) => {
    seatProbe = { at: Date.now(), up: SEAT_IDS.filter((s, i) => r[i]), pending: null };
    return seatProbe.up;
  });
  return seatProbe.pending;
}
function seatReport(up) {
  return seatState().map((s) => ({ ...s, up: up.includes(s.id) }));
}
app.get('/api/pc/seats', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ seats: seatReport(await seatsUp()) });
});
app.post('/api/pc/claim', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
  const up = await seatsUp();
  const got = claimSeat(up, ip);
  if (got) return res.json({ ok: true, seat: got.seat, token: got.token });
  res.json({ ok: false, full: up.length > 0, seats: seatReport(up) });
});
app.use('/api/ac', suggestRouter);
app.use('/api/suggest', suggestRouter);

app.get('/adblock/stats', (req, res) => res.json(adStats));
app.get('/api/watch/stats', (req, res) => res.json(watchStats()));
app.get('/api/pc/power', (req, res) => res.json(vmPowerStats()));

/* Keep DuckDNS pointed at this machine.
 *
 * A home connection gets a new public IP whenever the router reconnects, and
 * when that happens the hostname keeps pointing at whoever got the old one -
 * the site goes dark for everyone while still looking fine from this PC, which
 * resolves it locally. A scheduled task would need admin rights; this server
 * already runs whenever the site is meant to be up, which is exactly the right
 * lifetime for the job.
 */
if (duckEnabled) {
  const DUCK_EVERY = 10 * 60 * 1000;
  const refresh = () =>
    updateDuckDns().catch((e) =>
      console.warn('[duckdns] ' + (e && e.message ? e.message : e)),
    );
  refresh();
  const duckTimer = setInterval(refresh, DUCK_EVERY);
  /* Never hold the process open just for this. */
  if (duckTimer.unref) duckTimer.unref();
  console.log('[duckdns] refreshing every ' + DUCK_EVERY / 60000 + ' minutes');
}

app.get('/healthz', (req, res) => res.json({ ok: true, engine: 'ultraviolet' }));
// The Brazilian funk pack lives outside the project (242MB, not worth
// copying), so it is served from wherever SAMPLES_DIR points. Paths are
// resolved and then checked to still sit under that root, otherwise
// ?p=../../.. would walk the whole disk.
const SAMPLES_DIR = process.env.SAMPLES_DIR || '';
app.get('/studio/sample', (req, res) => {
  if (!SAMPLES_DIR) return res.status(503).json({ error: 'SAMPLES_DIR is not set' });
  const rel = String(req.query.p || '');
  if (!rel) return res.status(400).json({ error: 'missing p' });
  const root = resolve(SAMPLES_DIR);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return res.status(403).json({ error: 'outside the sample root' });
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return res.status(404).json({ error: 'no such sample' });
  }
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(abs);
});


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
const FAIL_LOUD = /(^|\.)(imasdk\.googleapis\.com|googletagservices\.com|securepubads\.g\.doubleclick\.net|headerlift\.com|improvedigital\.com)$/i;
function failLoud(target) {
  try { return FAIL_LOUD.test(new URL(target).hostname); } catch { return false; }
}
/* Cloud Gaming (now.gg) shows ads, and the owner wants them let through there
   (2026-11-07). The bare request carries the proxied page's Referer / Origin in
   x-bare-headers, so an ad request now.gg made goes out, and so does anything
   that ad loads in turn (its referer is the ad itself, which only got loaded
   because now.gg asked for it). Every other site stays ad-blocked. */
const ADS_OK = /(^|\.)now\.gg$/i;
/* Google's ad loader puts each ad in a safeframe, requested from a blank
   frame with no referer. The loader itself is only let through for now.gg,
   so a safeframe request can only come from there. */
const AD_FRAMES = /(^|\.)safeframe\.googlesyndication\.com$/i;
function adsAllowedFor(req) {
  try { if (AD_FRAMES.test(new URL(req.headers['x-bare-url']).hostname)) return true; } catch { /* checked below */ }
  const raw = req.headers['x-bare-headers'];
  if (typeof raw !== 'string') return false;
  let h;
  try { h = JSON.parse(raw); } catch { return false; }
  if (!h || typeof h !== 'object') return false;
  for (const k of Object.keys(h)) {
    if (!/^(referer|origin)$/i.test(k)) continue;
    const from = String(Array.isArray(h[k]) ? h[k][0] : h[k]);
    let host;
    try { host = new URL(from).hostname; } catch { continue; }
    if (ADS_OK.test(host) || isBlocked(from)) return true;
  }
  return false;
}
function adBlocked(req, res) {
  const target = req.headers['x-bare-url'];
  if (typeof target !== 'string') return false;
  if (!isBlocked(target)) { adStats.allowed++; return false; }
  if (adsAllowedFor(req)) { adStats.cloudAds = (adStats.cloudAds || 0) + 1; return false; }
  adStats.blocked++;
  /* Which hosts get blocked most, for /adblock/stats. Capped so it can't grow. */
  try {
    const bh = adStats.hosts || (adStats.hosts = {});
    const hn = new URL(target).hostname;
    if (bh[hn] || Object.keys(bh).length < 200) bh[hn] = (bh[hn] || 0) + 1;
  } catch { /* bad URL: counted above */ }
  /* Ad players must visibly fail: an empty 204 "loads" as a script, so an ad
     SDK sits waiting for a player that never appears (GameDistribution games
     stayed black). A 403 fires the script's error, and the SDK starts the
     game without an ad. */
  if (failLoud(target)) {
    res.writeHead(403, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.end('blocked');
    return true;
  }
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
  /* On the single-server layout the proxy sits under /x/. Caddy strips that
     prefix for ordinary requests but forwarded WebSocket upgrades with it
     still on, so every socket under /x/ (VM screens, VM control, voice)
     matched nothing and answered 502. Strip it here as well. */
  if (req.url.startsWith('/x/')) req.url = req.url.slice(2);
  if (bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
  if (req.url.startsWith('/wisp/')) return wisp.routeRequest(req, socket, head);
  if (isBridgeRequest(req.url)) return handleBridgeUpgrade(req, socket, head);
  if (isControlRequest(req.url)) return handleControlUpgrade(req, socket, head);
  if (isVoiceRequest(req.url)) return handleVoiceUpgrade(req, socket, head);
  if (isWatchRequest(req.url)) return handleWatchUpgrade(req, socket, head);
  if (isStudioCollab(req.url)) return handleStudioUpgrade(req, socket, head);
  console.warn('[upgrade] no route for ' + String(req.url).slice(0, 120));
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

/* Express's default error page is a full stack trace, which hands anyone who
 * sends a malformed body the absolute paths on this machine. Answer JSON
 * routes with JSON and keep the detail in the log. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const bad = err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError);
  const tooBig = err && err.type === 'entity.too.large';
  console.warn('[http] ' + (err && err.message ? err.message : err));
  res.status(bad ? 400 : tooBig ? 413 : 500).json({
    error: bad ? 'malformed request body' : tooBig ? 'that was too large' : 'server error',
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log('xenon-proxy listening on ' + port);
  console.log(authEnabled ? 'proxy is password protected' : 'WARNING: proxy is OPEN - set XENON_PASSWORD in .env');
});
