/**
 * One command that keeps Xenon reachable.
 *
 * The recurring failure was never the proxy itself: it was that a Cloudflare
 * quick tunnel gets a NEW random hostname every time it starts, while the
 * portal had the OLD hostname baked into a page the browser and the host both
 * cache. The portal then sat on "opening transport" talking to a dead URL.
 *
 * This launcher removes the manual step. It:
 *   1. starts the proxy server,
 *   2. starts the tunnel and reads the fresh URL out of its output,
 *   3. waits until the tunnel actually answers /healthz,
 *   4. writes that URL to the WordPress `proxy-endpoint` page, which every
 *      visitor re-reads on load,
 *   5. keeps watching, and repeats 2-4 if either process dies.
 *
 * Without WP credentials it still runs; it just prints the URL for you to
 * paste into that page yourself.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT      = process.env.PORT || '8080';
const WP_SITE   = (process.env.WP_SITE || 'https://xenonsschoollearning.online').replace(/\/+$/, '');
const WP_USER   = process.env.WP_USER || '';
const WP_PASS   = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const WP_PAGE   = process.env.WP_ENDPOINT_PAGE || '171';
const CAN_PUBLISH = Boolean(WP_USER && WP_PASS);

const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let serverProc = null;
let tunnelProc = null;
let liveUrl = '';
let stopping = false;
let missedBeats = 0;

const log = (...a) => console.log('[xenon]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cloudflaredBin() {
  try {
    return require('cloudflared').bin;
  } catch {
    return join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'cloudflared.cmd' : 'cloudflared');
  }
}

/* ---------------------------------------------------------------- server -- */

function startServer() {
  serverProc = spawn(process.execPath, ['--use-system-ca', 'server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT },
  });
  serverProc.on('exit', (code) => {
    if (stopping) return;
    log(`server exited (${code}) - restarting in 2s`);
    setTimeout(startServer, 2000);
  });
}

async function waitForLocal() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

/* ---------------------------------------------------------------- tunnel -- */

function startTunnel() {
  liveUrl = '';
  missedBeats = 0;

  tunnelProc = spawn(
    cloudflaredBin(),
    ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // cloudflared prints the URL on stderr, but it has moved between streams
  // across versions, so scan both.
  const scan = (chunk) => {
    const hit = String(chunk).match(TUNNEL_RE);
    if (hit && !liveUrl) onTunnelUp(hit[0]);
  };
  tunnelProc.stdout.on('data', scan);
  tunnelProc.stderr.on('data', scan);

  tunnelProc.on('exit', (code) => {
    if (stopping) return;
    log(`tunnel exited (${code}) - restarting in 3s`);
    liveUrl = '';
    setTimeout(startTunnel, 3000);
  });
}

async function onTunnelUp(url) {
  liveUrl = url;
  log('tunnel opened:', url);

  // A quick tunnel answers its own hostname before it can reach the origin,
  // so publishing immediately would hand visitors a URL that 502s.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${url}/healthz`, { cache: 'no-store' });
      if (r.ok) { ready = true; break; }
    } catch { /* still warming */ }
    await sleep(1000);
  }
  if (!ready) {
    log('tunnel never answered /healthz - cycling it');
    try { tunnelProc.kill(); } catch { /* already gone */ }
    return;
  }

  await publish(url);
  banner(url);
}

/* ------------------------------------------------------------- publishing -- */

async function publish(url) {
  if (!CAN_PUBLISH) return;
  try {
    const res = await fetch(`${WP_SITE}/wp-json/wp/v2/pages/${WP_PAGE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64'),
      },
      body: JSON.stringify({ content: url, status: 'publish' }),
    });
    if (res.ok) log('published to WordPress - visitors pick this up on next load');
    else log(`WordPress rejected the update (${res.status}) - paste it manually, see below`);
  } catch (err) {
    log('could not reach WordPress:', err.message);
  }
}

function banner(url) {
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n  XENON IS LIVE\n  ${url}\n`);
  if (CAN_PUBLISH) {
    console.log('  The portal was updated automatically. Nothing else to do.');
  } else {
    console.log('  No WP credentials in .env, so paste this URL into:');
    console.log(`  ${WP_SITE}/wp-admin/  ->  Pages  ->  proxy-endpoint  ->  Update`);
    console.log('  (see .env.example to make this automatic)');
  }
  console.log(`${bar}\n`);
}

/* -------------------------------------------------------------- heartbeat -- */

// If the tunnel silently stops forwarding, cloudflared often stays alive. Poll
// through the public URL rather than trusting the process to exit.
async function heartbeat() {
  if (stopping || !liveUrl) return;
  try {
    const r = await fetch(`${liveUrl}/healthz`, { cache: 'no-store' });
    if (r.ok) { missedBeats = 0; return; }
  } catch { /* counted below */ }
  missedBeats++;
  log(`tunnel health check failed (${missedBeats}/2)`);
  if (missedBeats >= 2) {
    log('cycling the tunnel');
    liveUrl = '';
    try { tunnelProc.kill(); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ main -- */

function shutdown() {
  stopping = true;
  for (const p of [tunnelProc, serverProc]) { try { p && p.kill(); } catch { /* gone */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('starting server on port', PORT);
startServer();
if (!(await waitForLocal())) {
  log('server never became healthy - check the output above');
  shutdown();
}
log('server healthy, opening tunnel');
startTunnel();
setInterval(heartbeat, 60000);
