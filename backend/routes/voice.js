import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { settings } from '../site-settings.js';

/* Voice channel for the chat page.
 *
 * Audio never touches this server: browsers connect to each other directly
 * over WebRTC, and this socket only relays the setup messages (offer, answer,
 * ICE candidates) between people who pressed Join. Anyone with the chat page
 * open also gets the roster, so the sidebar can show who is in voice.
 *
 *   client -> server  {t:'join', name, border, uid}   enter voice
 *                     {t:'leave'}                      leave voice (stay listening)
 *                     {t:'signal', to, data}           WebRTC setup for one peer
 *                     {t:'state', muted, deaf}         mic / deafen state
 *
 * Calls (2026-10-28): join may carry ch=<DM or group id> plus the chat token;
 * that channel is a private call only the chat's members can enter. '' is
 * the public Lounge. Rosters and signals never cross channels.
 *
 *   server -> client  {t:'hello', id, peers}           on connect
 *                     {t:'roster', peers}              whenever voice changes
 *                     {t:'welcome', peers}             after join: who to call
 *                     {t:'signal', from, data}
 *                     {t:'full'}                       channel at capacity
 */

const MAX_IN_VOICE = 12;            // a full mesh past this gets heavy
const MAX_MSG = 64 * 1024;          // SDP + candidates fit easily
const RATE = 120;                   // messages per socket per 10 s
const CHANNEL = 'Lounge';

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
const clients = new Map();          // id -> {ws, inVoice, ch, name, border, uid, muted, deaf}
/* Set by chat.js: (roomId, token) -> true when that device is a member. */
let canJoin = () => false;
export function setCallCheck(fn) { canJoin = fn; }

const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function roster(ch = '') {
  const out = [];
  for (const [id, c] of clients) {
    if (c.inVoice && c.ch === ch) out.push({ id, name: c.name, border: c.border, uid: c.uid, muted: c.muted, deaf: c.deaf });
  }
  return out;
}
function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
/* The Lounge's roster goes to everyone (the sidebar shows it); a call's
   only to the people in it. */
function broadcastRoster(ch = '') {
  const msg = { t: 'roster', channel: ch ? 'call' : CHANNEL, ch, peers: roster(ch) };
  for (const c of clients.values()) { if (!ch || c.ch === ch) send(c.ws, msg); }
}
/* Who is in a chat's call right now, for the chat's room list. */
export function callRoster(ch) { return ch ? roster(ch).map((p) => p.name) : []; }

export function isVoiceRequest(url) {
  return url === '/voice' || url.startsWith('/voice?');
}

export function handleVoiceUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const id = randomBytes(6).toString('hex');
    const me = { ws, inVoice: false, ch: '', name: 'anon', border: 'none', uid: '', muted: false, deaf: false, alive: true, count: 0, window: Date.now() };
    clients.set(id, me);
    send(ws, { t: 'hello', id, channel: CHANNEL, peers: roster(), max: MAX_IN_VOICE });

    ws.on('pong', () => { me.alive = true; });
    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - me.window > 10000) { me.window = now; me.count = 0; }
      if (++me.count > RATE) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'join') {
        if (me.inVoice) return;
        const ch = String(m.ch || '').slice(0, 40);
        if (ch && !canJoin(ch, String(m.token || ''))) { send(ws, { t: 'denied' }); return; }
        if (roster(ch).length >= MAX_IN_VOICE) { send(ws, { t: 'full', max: MAX_IN_VOICE }); return; }
        me.ch = ch;
        if (settings().voiceLocked) { send(ws, { t: 'locked' }); return; }
        me.name = clean(m.name, 24) || 'anon';
        me.border = clean(m.border, 60) || 'none';
        me.uid = clean(m.uid, 32);
        me.muted = !!m.muted; me.deaf = !!m.deaf;
        /* The newcomer calls everyone already here; nobody calls them. */
        send(ws, { t: 'welcome', ch: me.ch, peers: roster(me.ch) });
        me.inVoice = true;
        broadcastRoster(me.ch);
      } else if (m.t === 'leave') {
        if (!me.inVoice) return;
        me.inVoice = false;
        const was = me.ch;
        me.ch = '';
        broadcastRoster(was);
        if (was) send(ws, { t: 'roster', channel: CHANNEL, ch: '', peers: roster('') });
      } else if (m.t === 'state') {
        if (!me.inVoice) return;
        me.muted = !!m.muted; me.deaf = !!m.deaf;
        broadcastRoster(me.ch);
      } else if (m.t === 'signal') {
        /* Only between two people who are both in voice. */
        if (!me.inVoice) return;
        const to = clients.get(String(m.to || ''));
        if (!to || !to.inVoice || to.ch !== me.ch) return;
        send(to.ws, { t: 'signal', from: id, data: m.data });
      }
    });
    const gone = () => {
      if (!clients.has(id)) return;
      const was = me.inVoice;
      clients.delete(id);
      if (was) broadcastRoster(me.ch);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  });
}

/* Drop sockets whose browser vanished without closing. */
setInterval(() => {
  for (const [id, c] of clients) {
    if (!c.alive) { try { c.ws.terminate(); } catch {} clients.delete(id); if (c.inVoice) broadcastRoster(c.ch); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 25000).unref();

/* Used only by the admin panel. */
export const voiceAdmin = {
  list() { return roster(); },
  kick(id) {
    const c = clients.get(id);
    if (!c) return false;
    send(c.ws, { t: 'kicked' });
    try { c.ws.close(4001, 'kicked'); } catch {}
    clients.delete(id);
    if (c.inVoice) broadcastRoster(c.ch);
    return true;
  },
  kickAll() { for (const id of [...clients.keys()]) { const c = clients.get(id); if (c.inVoice) this.kick(id); } },
};

export function voiceStats() {
  return { connected: clients.size, inVoice: roster().length };
}
