/* Discord chat bridge (2026-11-15): lets people on the Xenon site read and
 * post in the Discord server's #general without touching discord.com,
 * which school Chromebooks block. Everything goes through this proxy.
 *
 *   GET  /api/dc/messages        latest #general messages (read with the
 *                                Xenon Bot; needs its Message Content Intent)
 *   POST /api/dc/send            {token, id, name, text} -> posted through a
 *                                webhook as "<name> (Xenon)" with their avatar
 *   GET  /api/dc/img?u=          Discord avatars/attachments, fetched here
 *                                (cdn.discordapp.com is blocked at schools)
 *
 * Secrets: the bot token is read from ../xenon-bot/.env (DISCORD_TOKEN), the
 * webhook from backend/data/discord-bridge.json - both git-ignored. Neither
 * is ever sent to the browser. Guests are rate limited per address, slurs
 * and @everyone/@here are blocked, and site bans apply here too.
 */
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, clientIp, ipHash } from '../site-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const router = express.Router();

function cfg() {
  try {
    const b = JSON.parse(readFileSync(join(ROOT, 'backend', 'data', 'discord-bridge.json'), 'utf8'));
    const envFile = process.env.DISCORD_BOT_ENV || join(ROOT, '..', 'xenon-bot', '.env');
    const m = existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^\s*DISCORD_TOKEN\s*=\s*"?([^"\r\n]+)"?\s*$/m) : null;
    return { ...b, botToken: process.env.DISCORD_TOKEN || (m ? m[1].trim() : '') };
  } catch { return null; }
}

/* ---------------------------------------------------------- reading */
let cache = { at: 0, list: [], error: '' };
let lastWanted = 0;
let busy = false;
async function refresh() {
  const c = cfg();
  if (!c || !c.botToken) { cache = { at: Date.now(), list: [], error: 'bridge not set up' }; return; }
  busy = true;
  try {
    const r = await fetch('https://discord.com/api/v10/channels/' + c.channel + '/messages?limit=50', { headers: { Authorization: 'Bot ' + c.botToken } });
    if (!r.ok) throw new Error('discord ' + r.status);
    const raw = await r.json();
    cache = { at: Date.now(), list: raw.reverse().filter((m) => m.type === 0 || m.type === 19).map(shape), error: '' };
  } catch (e) {
    cache = { at: Date.now(), list: cache.list, error: String(e.message || e).slice(0, 80) };
  } finally { busy = false; }
}
function img(u) { return u ? '/api/dc/img?u=' + encodeURIComponent(u) : ''; }
function shape(m) {
  const names = Object.fromEntries((m.mentions || []).map((u) => [u.id, u.global_name || u.username]));
  let text = String(m.content || '')
    .replace(/<@!?(\d+)>/g, (s, id) => '@' + (names[id] || 'user'))
    .replace(/<#(\d+)>/g, '#channel')
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
  const a = m.author || {};
  const web = Boolean(m.webhook_id);
  const avatar = a.avatar ? 'https://cdn.discordapp.com/avatars/' + a.id + '/' + a.avatar + '.png?size=64' : '';
  return {
    id: m.id,
    name: web ? a.username : (m.member && m.member.nick) || a.global_name || a.username || 'user',
    site: web,
    bot: Boolean(a.bot) && !web,
    av: web ? (a.avatar ? img(avatar) : '') : img(avatar),
    text: text.slice(0, 2000),
    imgs: (m.attachments || []).filter((x) => /^image\//.test(x.content_type || '')).slice(0, 4).map((x) => img(x.proxy_url || x.url)),
    ts: Date.parse(m.timestamp) || 0,
  };
}
router.get('/messages', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  lastWanted = Date.now();
  if (Date.now() - cache.at > 3500 && !busy) await refresh();
  res.json({ messages: cache.list, error: cache.error || undefined });
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
let presenceMod = null;
router.post('/send', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const ip = clientIp(req);
  if (limited('a:' + ip, 1, 2500) || limited('m:' + ip, 15, 60000)) return res.status(429).json({ error: 'slow down a moment' });
  const S = settings();
  if (S.chatLocked) return res.status(403).json({ error: 'chat is locked right now' });
  if (S.bannedDevices.includes(ipHash(ip))) return res.status(403).json({ error: 'you cannot post here' });
  if (presenceMod === null) presenceMod = await import('./presence.js').catch(() => false);
  const prof = presenceMod && presenceMod.nameById ? presenceMod.nameById(b.id) : '';
  let name = String(prof || b.name || '').replace(/[\u0000-\u001f<>@#:`]/g, '').replace(/discord|clyde|everyone|here/gi, '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'make a Xenon profile first (Settings > Profile)' });
  if (hasSlur(name) || (S.bannedNames || []).includes(name.toLowerCase())) return res.status(403).json({ error: 'that name is not allowed' });
  let text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (hasSlur(text)) return res.status(400).json({ error: 'that message has a word that is not allowed' });
  text = text.replace(/@(everyone|here)/gi, '@​$1');
  const c = cfg();
  if (!c || !c.webhookId) return res.status(503).json({ error: 'Discord chat is not set up' });
  let avatar;
  try {
    const p = presenceMod && presenceMod.pfpByName ? presenceMod.pfpByName(prof || name) : null;
    if (p && p.pfp && /^\/avatars\/[\w.-]+$/.test(p.pfp)) avatar = 'https://app.zpack.beauty' + p.pfp;
  } catch {}
  try {
    const r = await fetch('https://discord.com/api/webhooks/' + c.webhookId + '/' + c.webhookToken + '?wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, username: name + ' (Xenon)', avatar_url: avatar, allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Discord said ' + r.status });
    cache.at = 0;
    res.json({ ok: true });
  } catch { res.status(502).json({ error: 'could not reach Discord' }); }
});

export default router;
