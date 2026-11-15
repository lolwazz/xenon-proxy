/* Discord chat bridge (2026-11-15): lets people on the Xenon site read and
 * post in the Discord server without touching discord.com, which school
 * Chromebooks block. Everything goes through this proxy.
 *
 *   GET  /api/dc/channels        categories + channels everyone can see
 *                                (staff/hidden ones are left out)
 *   GET  /api/dc/messages?ch=    latest messages in one channel (read with
 *                                the Xenon Bot; needs Message Content Intent)
 *   POST /api/dc/send            {ch, token, id, name, text} -> posted
 *                                through that channel's webhook as
 *                                "<name> (Xenon)" with their avatar
 *   GET  /api/dc/img?u=          Discord avatars/attachments, fetched here
 *                                (cdn.discordapp.com is blocked at schools)
 *
 * Secrets: the bot token is read from ../xenon-bot/.env (DISCORD_TOKEN), the
 * webhooks live in backend/data/discord-bridge.json - both git-ignored and
 * never sent to the browser. A webhook is created the first time someone
 * posts in a channel. Channels members can't type in (@everyone denied Send
 * Messages, announcement channels) are read-only here too. Guests are rate
 * limited per address, slurs and @everyone/@here are blocked, and site bans
 * apply.
 */
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, clientIp, ipHash } from '../site-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DATA = join(ROOT, 'backend', 'data', 'discord-bridge.json');
const GUILD = '1571401078631571507';
const router = express.Router();

function saved() { try { return JSON.parse(readFileSync(DATA, 'utf8')); } catch { return {}; } }
function botToken() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  const envFile = process.env.DISCORD_BOT_ENV || join(ROOT, '..', 'xenon-bot', '.env');
  const m = existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^\s*DISCORD_TOKEN\s*=\s*"?([^"\r\n]+)"?\s*$/m) : null;
  return m ? m[1].trim() : '';
}
async function dapi(method, route, body) {
  const t = botToken();
  if (!t) throw new Error('bridge not set up');
  const r = await fetch('https://discord.com/api/v10' + route, {
    method, headers: { Authorization: 'Bot ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('discord ' + r.status);
  return r.status === 204 ? null : r.json();
}

/* ---------------------------------------------------------- channels */
const VIEW = 1n << 10n, SEND = 1n << 11n;
let chCache = { at: 0, cats: [], byId: new Map() };
function denied(ch, bit) {
  const o = (ch.permission_overwrites || []).find((x) => x.id === GUILD);
  return o ? (BigInt(o.deny) & bit) !== 0n : false;
}
async function channels() {
  if (Date.now() - chCache.at < 60000 && chCache.cats.length) return chCache;
  const all = await dapi('GET', '/guilds/' + GUILD + '/channels');
  const cats = all.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const usable = all.filter((c) => (c.type === 0 || c.type === 5)).filter((c) => {
    const cat = c.parent_id ? catById.get(c.parent_id) : null;
    return !denied(c, VIEW) && !(cat && denied(cat, VIEW) && !(c.permission_overwrites || []).some((o) => o.id === GUILD && (BigInt(o.allow) & VIEW)));
  }).sort((a, b) => a.position - b.position);
  const byId = new Map();
  const shapeCh = (c) => {
    const cat = c.parent_id ? catById.get(c.parent_id) : null;
    const ro = c.type === 5 || denied(c, SEND) || (cat && denied(cat, SEND) && !(c.permission_overwrites || []).some((o) => o.id === GUILD));
    const x = { id: c.id, name: c.name, topic: String(c.topic || '').slice(0, 200), ro: Boolean(ro), news: c.type === 5 };
    byId.set(c.id, x);
    return x;
  };
  const out = [];
  const loose = usable.filter((c) => !c.parent_id).map(shapeCh);
  if (loose.length) out.push({ id: '', name: '', channels: loose });
  for (const cat of cats) {
    const list = usable.filter((c) => c.parent_id === cat.id).map(shapeCh);
    if (list.length) out.push({ id: cat.id, name: cat.name, channels: list });
  }
  chCache = { at: Date.now(), cats: out, byId };
  return chCache;
}
router.get('/channels', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await channels();
    const def = saved().channel || '';
    res.json({ server: 'Xenon.', def: c.byId.has(def) ? def : (c.cats[0] && c.cats[0].channels[0] ? c.cats[0].channels[0].id : ''), cats: c.cats });
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 80) }); }
});

/* ---------------------------------------------------------- reading */
const caches = new Map(); /* channel id -> { at, list, error, busy } */
function img(u) { return u ? '/api/dc/img?u=' + encodeURIComponent(u) : ''; }

/* Who posted which site message (2026-11-15), so people can edit and
   delete their own: message id -> { o: owner key, ch, r: reply-to info }.
   The owner key is a hash of the visitor's chat token, never the token. */
const OWN_FILE = join(ROOT, 'backend', 'data', 'discord-bridge-owners.json');
let owners = {};
try { owners = JSON.parse(readFileSync(OWN_FILE, 'utf8')); } catch {}
let ownTimer = null;
function saveOwners() {
  clearTimeout(ownTimer);
  ownTimer = setTimeout(() => {
    const ids = Object.keys(owners);
    if (ids.length > 5000) for (const id of ids.sort().slice(0, ids.length - 5000)) delete owners[id];
    try { writeFileSync(OWN_FILE, JSON.stringify(owners)); } catch {}
  }, 1000);
}
const ownerKey = (token) => (token ? createHash('sha256').update('dcown:' + String(token)).digest('hex').slice(0, 24) : '');
const REPLY_LINE = /^> ↪ [^\n]*\n/;
function snippet(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80); }

function shape(m, names) {
  const men = Object.fromEntries((m.mentions || []).map((u) => [u.id, u.global_name || u.username]));
  let text = String(m.content || '')
    .replace(/<@!?(\d+)>/g, (s, id) => '@' + (men[id] || 'user'))
    .replace(/<#(\d+)>/g, (s, id) => '#' + (names.get(id) || 'channel'))
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
  for (const e of (m.embeds || []).slice(0, 2)) {
    const bits = [e.title, e.description].filter(Boolean).join('\n');
    if (bits) text += (text ? '\n' : '') + bits;
  }
  const a = m.author || {};
  const web = Boolean(m.webhook_id);
  const avatar = a.avatar ? 'https://cdn.discordapp.com/avatars/' + a.id + '/' + a.avatar + '.png?size=64' : '';
  /* Replies: real Discord replies carry the message they answer; site
     replies (webhooks can't make real ones) start with a quote line, which
     is shown as the reply preview instead of as text. */
  let reply = null;
  const own = owners[m.id];
  if (own && own.r) { reply = own.r; text = text.replace(REPLY_LINE, ''); }
  else if (m.referenced_message) {
    const rm = m.referenced_message; const ra = rm.author || {};
    reply = { id: rm.id, name: rm.webhook_id ? ra.username : ra.global_name || ra.username || 'user', text: snippet(rm.content) };
  }
  return {
    id: m.id,
    name: web ? a.username : a.global_name || a.username || 'user',
    site: web && / \(Xenon\)$/.test(a.username || ''),
    bot: Boolean(a.bot) && !(web && / \(Xenon\)$/.test(a.username || '')),
    av: avatar ? img(avatar) : '',
    text: text.slice(0, 2000),
    imgs: (m.attachments || []).filter((x) => /^image\//.test(x.content_type || '')).slice(0, 4).map((x) => img(x.proxy_url || x.url)),
    ts: Date.parse(m.timestamp) || 0,
    edited: Boolean(m.edited_timestamp),
    reply,
  };
}
router.get('/messages', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let c;
  try { c = await channels(); } catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 80) }); }
  const id = String(req.query.ch || saved().channel || '');
  if (!c.byId.has(id)) return res.status(404).json({ error: 'no such channel' });
  const k = caches.get(id) || { at: 0, list: [], error: '' };
  if (Date.now() - k.at > 3500 && !k.busy) {
    k.busy = true;
    try {
      const raw = await dapi('GET', '/channels/' + id + '/messages?limit=50');
      const names = new Map([...c.byId.values()].map((x) => [x.id, x.name]));
      k.list = raw.reverse().filter((m) => m.type === 0 || m.type === 19 || m.type === 20).map((m) => shape(m, names));
      k.error = '';
    } catch (e) { k.error = String(e.message || e).slice(0, 80); }
    k.at = Date.now(); k.busy = false;
    caches.set(id, k);
    if (caches.size > 100) caches.clear();
  }
  /* Mark the asker's own messages so the site can offer Edit / Delete. */
  const me = ownerKey(req.query.t);
  const list = me ? k.list.map((m) => (owners[m.id] && owners[m.id].o === me ? { ...m, mine: true } : m)) : k.list;
  res.json({ messages: list, error: k.error || undefined, ro: c.byId.get(id).ro });
});

/* ---------------------------------------------------------- images */
router.get('/img', async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).end(); }
  if (u.protocol !== 'https:' || !/^(cdn\.discordapp\.com|media\.discordapp\.net)$/.test(u.hostname)) return res.status(400).end();
  try {
    const r = await fetch(u.href);
    if (!r.ok) return res.status(r.status).end();
    const type = r.headers.get('content-type') || '';
    if (!/^image\//.test(type)) return res.status(415).end();
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

/* ---------------------------------------------------------- posting */
const SLUR = /nigg|faggot|\bfag\b|retard|tranny|\bchink|\bspic\b|kike|wetback|\bcoon\b|beaner|\bgook\b|raghead|towelhead|\bdyke/;
const fold = (s) => String(s).toLowerCase().replace(/[013457@$!|8]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' })[c] || c);
const hasSlur = (s) => SLUR.test(fold(s)) || /nigg|faggot|tranny|kike|wetback/.test(fold(s).replace(/[^a-z]/g, ''));
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const l = (hits.get(key) || []).filter((t) => now - t < ms);
  if (l.length >= max) { hits.set(key, l); return true; }
  l.push(now); hits.set(key, l);
  if (hits.size > 20000) hits.clear();
  return false;
}
/* One webhook per channel, made on first use and remembered. */
async function hookFor(ch) {
  const b = saved();
  b.hooks = b.hooks || {};
  if (b.channel === ch && b.webhookId && !b.hooks[ch]) b.hooks[ch] = { id: b.webhookId, token: b.webhookToken };
  if (b.hooks[ch]) return b.hooks[ch];
  const list = await dapi('GET', '/channels/' + ch + '/webhooks');
  let h = list.find((w) => w.name === 'Xenon Site Chat' && w.token);
  if (!h) h = await dapi('POST', '/channels/' + ch + '/webhooks', { name: 'Xenon Site Chat' });
  b.hooks[ch] = { id: h.id, token: h.token };
  writeFileSync(DATA, JSON.stringify(b, null, 1));
  return b.hooks[ch];
}
let presenceMod = null;
router.post('/send', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const ip = clientIp(req);
  if (limited('a:' + ip, 1, 2500) || limited('m:' + ip, 15, 60000)) return res.status(429).json({ error: 'slow down a moment' });
  const S = settings();
  if (S.chatLocked) return res.status(403).json({ error: 'chat is locked right now' });
  if (S.bannedDevices.includes(ipHash(ip))) return res.status(403).json({ error: 'you cannot post here' });
  let c;
  try { c = await channels(); } catch { return res.status(502).json({ error: 'could not reach Discord' }); }
  const ch = String(b.ch || saved().channel || '');
  const info = c.byId.get(ch);
  if (!info) return res.status(404).json({ error: 'no such channel' });
  if (info.ro) return res.status(403).json({ error: 'You do not have permission to send messages in this channel.' });
  if (presenceMod === null) presenceMod = await import('./presence.js').catch(() => false);
  const prof = presenceMod && presenceMod.nameById ? presenceMod.nameById(b.id) : '';
  const name = String(prof || b.name || '').replace(/[\u0000-\u001f<>@#:`]/g, '').replace(/discord|clyde|everyone|here/gi, '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'make a Xenon profile first' });
  if (hasSlur(name) || (S.bannedNames || []).includes(name.toLowerCase())) return res.status(403).json({ error: 'that name is not allowed' });
  let text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (hasSlur(text)) return res.status(400).json({ error: 'that message has a word that is not allowed' });
  text = text.replace(/@(everyone|here)/gi, '@​$1');
  let avatar;
  try {
    const p = presenceMod && presenceMod.pfpByName ? presenceMod.pfpByName(prof || name) : null;
    if (p && p.pfp && /^\/avatars\/[\w.-]+$/.test(p.pfp)) avatar = 'https://app.zpack.beauty' + p.pfp;
  } catch {}
  /* Replying: webhooks can't make real Discord replies, so the message
     starts with a quote line naming who it answers; the site shows it as a
     reply preview. */
  let r0 = null;
  if (b.reply) {
    const k0 = caches.get(ch);
    const t = k0 && k0.list.find((x) => x.id === String(b.reply));
    if (t) r0 = { id: t.id, name: String(t.name).replace(/ \(Xenon\)$/, ''), text: snippet(t.text) };
  }
  const content = r0 ? '> ↪ **' + r0.name.replace(/[*_`~|>]/g, '') + '**: ' + (r0.text || '...').replace(/[\n>]/g, ' ') + '\n' + text : text;
  const me = ownerKey(b.token);
  try {
    const h = await hookFor(ch);
    const r = await fetch('https://discord.com/api/webhooks/' + h.id + '/' + h.token + '?wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000), username: name + ' (Xenon)', avatar_url: avatar, allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Discord said ' + r.status });
    const msg = await r.json().catch(() => null);
    if (msg && msg.id && me) { owners[msg.id] = { o: me, ch, r: r0 || undefined }; saveOwners(); }
    const k = caches.get(ch); if (k) k.at = 0;
    res.json({ ok: true, id: msg && msg.id });
  } catch { res.status(502).json({ error: 'could not reach Discord' }); }
});

/* Edit / delete your own site messages, through the webhook that posted
   them. Only the person whose token posted it can (owners map). */
async function ownMsg(req, res) {
  const b = req.body || {};
  const ip = clientIp(req);
  if (limited('e:' + ip, 20, 60000)) { res.status(429).json({ error: 'slow down a moment' }); return null; }
  const id = String(b.id || '');
  const own = owners[id];
  const me = ownerKey(b.token);
  if (!own || !me || own.o !== me) { res.status(403).json({ error: 'you can only change your own messages' }); return null; }
  const h = await hookFor(own.ch).catch(() => null);
  if (!h) { res.status(502).json({ error: 'could not reach Discord' }); return null; }
  return { own, h, id };
}
router.post('/delete', express.json({ limit: '2kb' }), async (req, res) => {
  const o = await ownMsg(req, res);
  if (!o) return;
  const r = await fetch('https://discord.com/api/webhooks/' + o.h.id + '/' + o.h.token + '/messages/' + o.id, { method: 'DELETE' }).catch(() => null);
  if (!r || (!r.ok && r.status !== 404)) return res.status(502).json({ error: 'Discord would not delete it' });
  delete owners[o.id]; saveOwners();
  const k = caches.get(o.own.ch); if (k) { k.list = k.list.filter((x) => x.id !== o.id); k.at = 0; }
  res.json({ ok: true });
});
router.post('/edit', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  let text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (hasSlur(text)) return res.status(400).json({ error: 'that message has a word that is not allowed' });
  text = text.replace(/@(everyone|here)/gi, '@​$1');
  const o = await ownMsg(req, res);
  if (!o) return;
  const r0 = o.own.r;
  const content = r0 ? '> ↪ **' + r0.name.replace(/[*_`~|>]/g, '') + '**: ' + (r0.text || '...').replace(/[\n>]/g, ' ') + '\n' + text : text;
  const r = await fetch('https://discord.com/api/webhooks/' + o.h.id + '/' + o.h.token + '/messages/' + o.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
  }).catch(() => null);
  if (!r || !r.ok) return res.status(502).json({ error: 'Discord would not edit it' });
  const k = caches.get(o.own.ch); if (k) k.at = 0;
  res.json({ ok: true });
});

export default router;
