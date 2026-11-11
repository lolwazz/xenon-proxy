import express from 'express';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import os from 'node:os';
import { settings, setSettings, clientIp, ipHash } from '../site-settings.js';
import { chatAdmin } from './chat.js';
import { presenceAdmin } from './presence.js';
import { clipsAdmin } from './clips.js';
import { bookmarkletsAdmin } from './bookmarklets.js';
import { voiceAdmin } from './voice.js';
import { aiEnabled } from './ai.js';
import { probe, seatState } from './pc-bridge.js';
import { stats as adStats } from '../adblock.js';

/* The admin panel.
 *
 * The only way in is the secret URL /admin/<ADMIN_URL_TOKEN> (128 random
 * characters, in .env). The page then sends the same token on every API call
 * as X-Admin-Token. Anything without the right token gets the server's
 * ordinary 404, so the panel cannot be told apart from a page that does not
 * exist. An address that misses 8 times is shut out for 30 minutes, even if
 * it then guesses right. Every action is written to data/admin-audit.jsonl.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = join(HERE, '..', '..', '.env');
const PANEL = join(HERE, '..', 'admin', 'panel.html');
const AUDIT = join(HERE, '..', 'data', 'admin-audit.jsonl');
const STARTED = Date.now();

let TOKEN = process.env.ADMIN_URL_TOKEN || '';
const fails = new Map();             // ip -> {n, until}

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function gate(token, req) {
  if (!TOKEN || TOKEN.length < 64) return false;
  const ip = clientIp(req);
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.until > now) return false;
  if (same(token, TOKEN)) { fails.delete(ip); return true; }
  const n = (f && f.until <= now && f.n >= 8 ? 0 : (f ? f.n : 0)) + 1;
  fails.set(ip, { n, until: n >= 8 ? now + 30 * 60 * 1000 : 0 });
  if (fails.size > 5000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
  return false;
}
function audit(req, action, detail) {
  const line = JSON.stringify({ at: new Date().toISOString(), action, detail: detail == null ? '' : detail, from: ipHash(clientIp(req)) });
  try { appendFileSync(AUDIT, line + '\n'); } catch {}
}
function readAudit(n = 200) {
  try { return readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-n).reverse().map((l) => JSON.parse(l)); } catch { return []; }
}
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  return proto + '://' + req.headers.host;
}
const withTimeout = (p, ms, v) => Promise.race([p, new Promise((r) => setTimeout(() => r(v), ms))]);

/* ---------------------------------------------------------------- page */
export function adminPage(req, res, next) {
  if (!gate(req.params.token, req)) return next();
  let html;
  try { html = readFileSync(PANEL, 'utf8'); } catch { return next(); }
  const nonce = randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, max-age=0',
  });
  res.removeHeader('Access-Control-Allow-Origin');
  audit(req, 'open panel');
  res.type('html').send(html.split('__NONCE__').join(nonce));
}

/* ---------------------------------------------------------------- API */
const api = express.Router();
api.use((req, res, next) => {
  res.removeHeader('Access-Control-Allow-Origin');
  res.set('Cache-Control', 'no-store');
  if (!gate(req.get('x-admin-token'), req)) return next('router');
  next();
});
api.use(express.json({ limit: '64kb' }));

api.get('/overview', async (req, res) => {
  const mem = process.memoryUsage();
  const S = settings();
  res.json({
    server: {
      uptime: Math.round((Date.now() - STARTED) / 1000), node: process.version, platform: os.platform() + ' ' + os.release(),
      rss: mem.rss, heap: mem.heapUsed, freeMem: os.freemem(), totalMem: os.totalmem(),
      load: os.loadavg(), cpus: os.cpus().length, hostUptime: Math.round(os.uptime()),
    },
    counts: {
      online: presenceAdmin.online(), profiles: presenceAdmin.total(), messages: chatAdmin.count(),
      voice: voiceAdmin.list().length, bookmarklets: bookmarkletsAdmin.count(),
      clips: clipsAdmin.list().length, clipBytes: clipsAdmin.bytes(),
      adsBlocked: adStats.blocked, requestsAllowed: adStats.allowed,
    },
    ai: { configured: aiEnabled(), off: S.aiOff },
    settings: { ...S, salt: undefined },
  });
});

/* --- chat moderation --- */
api.get('/chat', (req, res) => res.json({ messages: chatAdmin.list(Math.min(1000, parseInt(req.query.limit, 10) || 200)) }));
api.post('/chat/delete', (req, res) => {
  const ok = chatAdmin.remove(parseInt(req.body.id, 10));
  if (ok) audit(req, 'delete message', req.body.id);
  res.json({ ok });
});
api.post('/chat/purge', (req, res) => {
  const name = String(req.body.name || '').slice(0, 24);
  const n = chatAdmin.purgeName(name);
  audit(req, 'purge messages', name + ' (' + n + ')');
  res.json({ ok: true, removed: n });
});
api.post('/chat/system', (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const id = chatAdmin.system(text);
  audit(req, 'system message', text.slice(0, 80));
  res.json({ ok: true, id });
});
api.get('/chat/export', (req, res) => {
  audit(req, 'export chat');
  res.set('Content-Disposition', 'attachment; filename="xenon-chat-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(chatAdmin.all());
});

/* --- settings: lock, slow mode, words, pin, banner, maintenance, voice, AI --- */
const EDITABLE = {
  chatLocked: (v) => !!v,
  slowSec: (v) => Math.max(0, Math.min(600, parseInt(v, 10) || 0)),
  words: (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 200),
  pinned: (v) => String(v || '').slice(0, 300),
  announce: (v) => ({ text: String((v && v.text) || '').slice(0, 300), level: ['info', 'warn', 'party'].includes(v && v.level) ? v.level : 'info' }),
  maintenance: (v) => ({ on: !!(v && v.on), text: String((v && v.text) || '').slice(0, 300) }),
  voiceLocked: (v) => !!v,
  aiOff: (v) => !!v,
};
api.post('/settings', (req, res) => {
  const patch = {};
  for (const k of Object.keys(req.body || {})) if (EDITABLE[k]) patch[k] = EDITABLE[k](req.body[k]);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
  const S = setSettings(patch);
  audit(req, 'settings', Object.keys(patch).join(', '));
  if (patch.voiceLocked) voiceAdmin.kickAll();
  res.json({ ok: true, settings: { ...S, salt: undefined } });
});

/* --- bans: by name, or by device (the salted address hash on a message) --- */
api.post('/ban', (req, res) => {
  const S = settings();
  const kind = req.body.kind === 'device' ? 'bannedDevices' : 'bannedNames';
  const v = String(req.body.value || '').trim().toLowerCase().slice(0, 32);
  if (!v) return res.status(400).json({ error: 'nothing to ban' });
  if (!S[kind].includes(v)) setSettings({ [kind]: S[kind].concat(v) });
  audit(req, 'ban ' + (kind === 'bannedDevices' ? 'device' : 'name'), v);
  res.json({ ok: true });
});
api.post('/unban', (req, res) => {
  const S = settings();
  const kind = req.body.kind === 'device' ? 'bannedDevices' : 'bannedNames';
  const v = String(req.body.value || '').trim().toLowerCase();
  setSettings({ [kind]: S[kind].filter((x) => x !== v) });
  audit(req, 'unban', v);
  res.json({ ok: true });
});

/* --- people --- */
api.get('/people', (req, res) => res.json({ people: presenceAdmin.list() }));
api.post('/people/forget', (req, res) => {
  const ok = presenceAdmin.forget(String(req.body.uid || ''));
  if (ok) audit(req, 'forget profile', req.body.uid);
  res.json({ ok });
});
api.post('/people/clear-offline', (req, res) => {
  const n = presenceAdmin.clearOffline(Math.max(1, parseInt(req.body.days, 10) || 7));
  audit(req, 'clear offline profiles', n);
  res.json({ ok: true, removed: n });
});

/* --- voice --- */
api.get('/voice', (req, res) => res.json({ peers: voiceAdmin.list(), locked: settings().voiceLocked }));
api.post('/voice/kick', (req, res) => {
  const ok = voiceAdmin.kick(String(req.body.id || ''));
  if (ok) audit(req, 'kick from voice', req.body.name || req.body.id);
  res.json({ ok });
});

/* --- content --- */
api.get('/bookmarklets', (req, res) => res.json({ items: bookmarkletsAdmin.list() }));
api.post('/bookmarklets/delete', (req, res) => {
  const ok = bookmarkletsAdmin.remove(parseInt(req.body.id, 10));
  if (ok) audit(req, 'delete bookmarklet', req.body.id);
  res.json({ ok });
});
api.post('/bookmarklets/official', (req, res) => {
  const ok = bookmarkletsAdmin.official(parseInt(req.body.id, 10), !!req.body.on);
  if (ok) audit(req, (req.body.on ? 'mark' : 'unmark') + ' official', req.body.id);
  res.json({ ok });
});
api.get('/clips', (req, res) => res.json({ clips: clipsAdmin.list() }));
api.post('/clips/delete', (req, res) => {
  const ok = clipsAdmin.remove(String(req.body.id || ''));
  if (ok) audit(req, 'delete clip', req.body.id);
  res.json({ ok });
});

/* --- machines --- */
api.get('/vms', async (req, res) => {
  const names = ['win10', 'seat1', 'seat2', 'seat3', 'seat4', 'android'];
  const up = await Promise.all(names.map((n) => withTimeout(Promise.resolve(probe(n)).catch(() => false), 4000, false)));
  res.json({ machines: names.map((n, i) => ({ name: n, up: !!up[i] })), seats: seatState() });
});

/* --- security --- */
api.get('/audit', (req, res) => res.json({ entries: readAudit(300) }));
api.post('/rotate', (req, res) => {
  const fresh = randomBytes(96).toString('base64url');
  try {
    let env = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
    if (/^ADMIN_URL_TOKEN=.*$/m.test(env)) env = env.replace(/^ADMIN_URL_TOKEN=.*$/m, 'ADMIN_URL_TOKEN=' + fresh);
    else env += '\nADMIN_URL_TOKEN=' + fresh + '\n';
    writeFileSync(ENV, env);
  } catch (e) { return res.status(500).json({ error: 'could not write .env' }); }
  audit(req, 'rotate admin URL');
  TOKEN = fresh;
  process.env.ADMIN_URL_TOKEN = fresh;
  res.json({ ok: true, url: baseUrl(req) + '/admin/' + fresh });
});
api.post('/restart', (req, res) => {
  audit(req, 'restart server');
  res.json({ ok: true });
  /* The launcher brings the server back in about two seconds. */
  setTimeout(() => process.exit(0), 300);
});

export const adminApi = api;

/* --- public: the banner and maintenance notice every page shows --- */
export function siteNotice(req, res) {
  const S = settings();
  res.set('Cache-Control', 'no-store');
  res.json({ announce: S.announce, maintenance: S.maintenance });
}
