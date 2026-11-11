import { WebSocketServer } from 'ws';
import { setLiveCheck, profileByDevice } from './presence.js';

/* Watch someone play (2026-11-07, owner's request: "people can see their game
 * while playing", no opt-in setting).
 *
 * Only the game is ever sent: the game page itself (games.zpack.beauty, via
 * scripts/games-pages/xn-watch.js) draws its own canvas into small JPEGs, and
 * only while at least one person is watching. The player's Xenon page passes
 * them through this socket. Nothing is stored. The player sees how many
 * people are watching ("👁 2 watching"), so it is never secret.
 *
 * A device is only live while a game is open on the games page, and only if
 * it shows its activity status (Settings > Show my activity): someone who
 * hid what they're doing doesn't get broadcast.
 *
 *   /watch?as=player  -> {t:'live', id, game}   a game opened (id = device id)
 *                        {t:'game', game}        the game's name became known
 *                        {t:'nope'}              this game can't be captured
 *                        <binary JPEG>           one frame
 *                     <- {t:'viewers', n}        how many are watching
 *   /watch?as=viewer&uid=<uid>
 *                     <- {t:'info', game, live}  {t:'nope'}  {t:'paused'}
 *                        {t:'ended'}  {t:'offline'}  {t:'full'}
 *                        <binary JPEG>
 */

const MAX_FRAME = 400 * 1024;   // a 640px JPEG is ~30-60 KB
const MIN_GAP = 150;            // at most ~6 frames a second per player
const MAX_VIEWERS = 12;         // all of it goes up this PC's connection
const SLOW = 1.5 * 1024 * 1024; // a viewer this far behind skips frames
const GRACE = 20 * 1000;        // switching games keeps the viewers waiting

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
const live = new Map();     // uid -> {ws, game, viewers:Set, last, nope}
const waiting = new Map();  // uid -> {game, viewers:Set, timer}

const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
}
function tellCount(p) { send(p.ws, { t: 'viewers', n: p.viewers.size }); }

export function isLive(uid) { return live.has(uid); }
setLiveCheck(isLive);

export function isWatchRequest(url) {
  return url === '/watch' || url.startsWith('/watch?');
}

export function handleWatchUpgrade(req, socket, head) {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => { try { ws.terminate(); } catch { /* gone */ } });
    if (q.get('as') === 'viewer') viewer(ws, clean(q.get('uid'), 16));
    else player(ws);
  });
}

function player(ws) {
  let me = null;
  let uid = '';
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!me || !me.viewers.size) return;
      const now = Date.now();
      if (now - me.last < MIN_GAP) return;
      /* JPEG only: anything else is not a game frame. */
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return;
      me.last = now;
      me.nope = false;
      for (const v of me.viewers) {
        if (v.readyState === 1 && v.bufferedAmount < SLOW) { try { v.send(data, { binary: true }); } catch { /* closing */ } }
      }
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'live' && !me) {
      const prof = profileByDevice(clean(m.id, 64));
      if (!prof || !prof.uid) { ws.close(4004, 'no profile'); return; }
      uid = prof.uid;
      const old = live.get(uid);
      const wait = waiting.get(uid);
      if (wait) { clearTimeout(wait.timer); waiting.delete(uid); }
      me = { ws, game: clean(m.game, 60), viewers: old ? old.viewers : (wait ? wait.viewers : new Set()), last: 0, nope: false };
      live.set(uid, me);
      /* A second tab with a game replaces the first. */
      if (old && old.ws !== ws) { try { old.ws.close(4000, 'replaced'); } catch { /* gone */ } }
      tellCount(me);
      for (const v of me.viewers) send(v, { t: 'info', game: me.game, live: true });
    } else if (m.t === 'game' && me) {
      me.game = clean(m.game, 60);
      for (const v of me.viewers) send(v, { t: 'info', game: me.game, live: true });
    } else if (m.t === 'nope' && me) {
      me.nope = true;
      for (const v of me.viewers) send(v, { t: 'nope' });
    }
  });
  ws.on('close', () => {
    if (!me || live.get(uid) !== me) return;
    live.delete(uid);
    if (!me.viewers.size) return;
    /* Hold the viewers for a moment: closing one game and opening the next
       comes straight back here. */
    for (const v of me.viewers) send(v, { t: 'paused' });
    const w = { game: me.game, viewers: me.viewers, timer: null };
    w.timer = setTimeout(() => {
      if (waiting.get(uid) !== w) return;
      waiting.delete(uid);
      for (const v of w.viewers) { send(v, { t: 'ended' }); try { v.close(1000); } catch { /* gone */ } }
    }, GRACE);
    waiting.set(uid, w);
  });
}

function viewer(ws, uid) {
  const p = live.get(uid) || waiting.get(uid);
  if (!p) { send(ws, { t: 'offline' }); ws.close(1000); return; }
  if (p.viewers.size >= MAX_VIEWERS) { send(ws, { t: 'full' }); ws.close(1000); return; }
  p.viewers.add(ws);
  const isLiveNow = live.get(uid) === p;
  send(ws, { t: 'info', game: p.game, live: isLiveNow });
  if (isLiveNow) { tellCount(p); if (p.nope) send(ws, { t: 'nope' }); }
  ws.on('close', () => {
    const cur = live.get(uid) || waiting.get(uid);
    if (!cur || !cur.viewers.delete(ws)) return;
    if (live.get(uid) === cur) tellCount(cur);
  });
}

/* Drop sockets whose browser vanished without closing. */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch { /* gone */ } continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* gone */ }
  }
}, 25000).unref();

export function watchStats() {
  let viewers = 0;
  for (const p of live.values()) viewers += p.viewers.size;
  return { live: live.size, viewers };
}
