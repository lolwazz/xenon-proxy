import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBareServer } from '@tomphttp/bare-server-node';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (p) => join(__dirname, 'node_modules', p);

const app = express();
app.use(compression());

// Allow the Xenon portal (or anything) to link into this proxy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// public/ is mounted FIRST so our own uv.config.js overrides the package default.
app.use(express.static(join(__dirname, 'public')));
app.use('/uv/',      express.static(pkg('@titaniumnetwork-dev/ultraviolet/dist')));
app.use('/scram/',   express.static(pkg('@mercuryworkshop/scramjet/dist')));
app.use('/baremux/', express.static(pkg('@mercuryworkshop/bare-mux/dist')));
app.use('/epoxy/',   express.static(pkg('@mercuryworkshop/epoxy-transport/dist')));
app.use('/libcurl/', express.static(pkg('@mercuryworkshop/libcurl-transport/dist')));
app.use('/baremod/', express.static(pkg('@mercuryworkshop/bare-as-module3/dist')));

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

server.on('request', (req, res) => {
  if (bare.shouldRoute(req)) {
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
server.listen(port, () => console.log('xenon-proxy listening on ' + port));
