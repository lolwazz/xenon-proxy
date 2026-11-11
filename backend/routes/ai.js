/**
 * The AI bot.
 *
 * The whole point of this file is that the API keys stay here. The portal is
 * a public site, so a key in its JavaScript is a key anyone can read with
 * View Source and spend - which is exactly how the keys in the old radical
 * page ended up exposed. The browser asks this route a question; this route
 * holds the credentials and answers.
 *
 * Providers, in the order they are tried for plain text:
 *   OpenRouter  - one key, hundreds of models, so the model picker is real
 *   Groq        - fast, generous free tier
 *   Gemini      - also the vision path, used when an image is attached
 *
 * Set whichever you have in .env: OPENROUTER_KEY, GROQ_KEY, GEMINI_KEY.
 */
import express from 'express';
import { settings } from '../site-settings.js';
import { PERSONALITIES, DEFAULT_PERSONALITY } from '../data/personalities.js';

const router = express.Router();

const KEYS = {
  openrouter: process.env.OPENROUTER_KEY || '',
  groq: process.env.GROQ_KEY || '',
  gemini: process.env.GEMINI_KEY || '',
  cohere: process.env.COHERE_KEY || '',
};

const MAX_PROMPT = 4000;
const MAX_HISTORY = 12;          // turns kept for context
const REPLY_TIMEOUT_MS = 60000;

/* One question at a time per person, and a short gap between them. Without
   this a loop in someone's console empties the account. */
const MIN_GAP_MS = 1500;
const lastAsk = new Map();
const inFlight = new Set();

function tooSoon(ip) {
  const now = Date.now();
  const prev = lastAsk.get(ip) || 0;
  if (now - prev < MIN_GAP_MS) return true;
  lastAsk.set(ip, now);
  if (lastAsk.size > 4000) {
    for (const [k, t] of lastAsk) { if (now - t > 120000) lastAsk.delete(k); }
  }
  return false;
}

const who = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
  .split(',')[0].trim();

/* A key the provider has switched off (Google kills keys it finds posted
   online) answers every call with 400/403. Find that out once at start-up so
   the model list stops offering it and pictures go to Cohere instead. */
const dead = new Set();
if (KEYS.gemini) {
  fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(KEYS.gemini), { signal: AbortSignal.timeout(15000) })
    .then((r) => { if (r.status === 400 || r.status === 401 || r.status === 403) { dead.add('gemini'); console.log('[ai] the Gemini key was refused - put a new GEMINI_KEY in .env'); } })
    .catch(() => {});
}
const live = (p) => Boolean(KEYS[p]) && !dead.has(p);

/* Some models now and then fall into a loop and print one phrase forever.
   Treat that as no answer so the next provider gets a turn. */
function looping(text) {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const seenL = new Map();
  for (const l of lines) { const n = (seenL.get(l) || 0) + 1; if (n >= 3 && l.length > 8) return true; seenL.set(l, n); }
  return false;
}

export function aiEnabled() {
  return Boolean(KEYS.openrouter || KEYS.groq || KEYS.gemini);
}

/* ------------------------------------------------------------- providers */

async function viaOpenRouter(messages, model, signal) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + KEYS.openrouter,
      'Content-Type': 'application/json',
      /* OpenRouter asks for these so usage shows up attributed. */
      'HTTP-Referer': 'https://xenonsschoollearning.online',
      'X-Title': 'Xenon',
    },
    body: JSON.stringify({
      model: model || 'openai/gpt-4o-mini',
      messages,
      max_tokens: 1200,
    }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('openrouter ' + r.status));
  const c = j.choices && j.choices[0];
  return (c && c.message && c.message.content) || '';
}

async function viaGroq(messages, model, signal) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEYS.groq, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'openai/gpt-oss-120b', messages, max_tokens: 1200 }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('groq ' + r.status));
  const c = j.choices && j.choices[0];
  return (c && c.message && c.message.content) || '';
}

/* Gemini takes a different shape, and is the only one here that reads images.
   `image` is a bare base64 JPEG - the screen-share frames arrive that way. */
async function viaGemini(messages, model, image, signal) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const turns = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  if (image && turns.length) {
    turns[turns.length - 1].parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  }
  const name = model && model.startsWith('gemini') ? model : 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + name +
    ':generateContent?key=' + encodeURIComponent(KEYS.gemini);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: turns,
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      generationConfig: { maxOutputTokens: 1200 },
    }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('gemini ' + r.status));
  const cand = j.candidates && j.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  return (parts || []).map((p) => p.text || '').join('').trim();
}


/* Cohere. Carried over from the old radical page, which used it as the
   "infinite talk time" option - a generous free tier. Its chat API takes the
   same message shape as the OpenAI-style ones. */
async function viaCohere(messages, model, signal, image) {
  if (image) {
    messages = messages.slice();
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { role: 'user', content: [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } }] };
  }
  const r = await fetch('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEYS.cohere, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: image ? 'command-a-vision-07-2025' : model && model.startsWith('command') ? model : 'command-a-03-2025',
      temperature: 0.7,
      messages,
      max_tokens: 1200,
    }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.message || j.error || 'cohere ' + r.status));
  const parts = j.message && j.message.content;
  if (Array.isArray(parts)) return parts.map((p) => p.text || '').join('').trim();
  return String((j.text || '')).trim();
}

/* ------------------------------------------------------------- the route */

router.post('/chat', express.json({ limit: '8mb' }), async (req, res) => {
  if (settings().aiOff) return res.status(503).json({ error: 'the AI is switched off right now' });
  if (!aiEnabled()) {
    return res.status(503).json({ error: 'no AI key configured on the server' });
  }
  const ip = who(req);
  if (inFlight.has(ip)) return res.status(429).json({ error: 'one question at a time' });
  if (tooSoon(ip)) return res.status(429).json({ error: 'slow down a moment' });

  const b = req.body || {};
  const prompt = String(b.prompt || '').trim().slice(0, MAX_PROMPT);
  if (!prompt) return res.status(400).json({ error: 'nothing to answer' });

  const personality = PERSONALITIES[b.personality] ? b.personality : DEFAULT_PERSONALITY;
  const name = String(b.name || '').trim().slice(0, 24) || 'someone';
  /* Screen-share frames. They are never stored and never broadcast - they go
     into this one request and nowhere else. */
  const image = typeof b.image === 'string' && b.image.length < 6000000
    ? b.image.replace(/^data:image\/[a-z]+;base64,/, '')
    : '';

  const history = Array.isArray(b.history) ? b.history.slice(-MAX_HISTORY) : [];
  const messages = [{ role: 'system', content: PERSONALITIES[personality] + ' The user you are talking to is called ' + name + '.' }];
  for (const h of history) {
    const role = h && h.role === 'assistant' ? 'assistant' : 'user';
    const content = String((h && h.content) || '').slice(0, MAX_PROMPT);
    if (content) messages.push({ role, content });
  }
  messages.push({ role: 'user', content: prompt });

  const model = String(b.model || '').slice(0, 80);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REPLY_TIMEOUT_MS);
  inFlight.add(ip);

  /* An image forces Gemini, which is the only vision provider wired up here.
     Otherwise try the providers in order and fall through on failure, so one
     provider being down or out of quota does not take the bot offline. */
  const groqIds = ['openai/gpt-oss', 'qwen/', 'allam-', 'llama'];
  const isGroq = groqIds.some((p) => model.startsWith(p));
  const order = image
    ? ['gemini', 'cohere']
    : isGroq ? ['groq', 'cohere', 'openrouter']
      : model.startsWith('command') ? ['cohere', 'groq', 'openrouter']
        : model.startsWith('gemini') ? ['gemini', 'cohere', 'groq']
          : model.includes('/') ? ['openrouter', 'groq', 'cohere']
            : ['groq', 'cohere', 'openrouter', 'gemini'];
  const tried = [];
  try {
    for (const p of order) {
      if (!live(p)) continue;
      try {
        let text;
        if (p === 'openrouter') text = await viaOpenRouter(messages, model, ctl.signal);
        else if (p === 'groq') text = await viaGroq(messages, model, ctl.signal);
        else if (p === 'cohere') text = await viaCohere(messages, model, ctl.signal, image);
        else text = await viaGemini(messages, model, image, ctl.signal);
        if (text && text.trim() && looping(text)) { tried.push(p + ': looped'); continue; }
        if (text && text.trim()) {
          return res.json({ ok: true, text: text.trim(), provider: p, personality });
        }
        tried.push(p + ': empty reply');
      } catch (e) {
        if (ctl.signal.aborted) break;
        /* Never echo the provider's raw body back - it can contain the key. */
        tried.push(p + ': ' + String(e.message || 'failed').slice(0, 120));
      }
    }
    if (ctl.signal.aborted) return res.status(504).json({ error: 'the model took too long' });
    return res.status(502).json({ error: 'no provider could answer', tried });
  } finally {
    clearTimeout(timer);
    inFlight.delete(ip);
  }
});

/* The model picker. Cached because the list is long and changes rarely. */
let modelCache = { at: 0, list: null };
router.get('/models', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const builtin = [];
  if (KEYS.groq) {
    builtin.push(
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (best here)', provider: 'groq' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (fast)', provider: 'groq' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen3 27B', provider: 'groq' },
    );
  }
  if (live('gemini')) {
    builtin.push(
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (vision)', provider: 'gemini' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (smartest)', provider: 'gemini' },
    );
  }
  if (KEYS.cohere) {
    builtin.push(
      { id: 'command-a-03-2025', label: 'Cohere Command A', provider: 'cohere' },
      { id: 'command-r-plus-08-2024', label: 'Cohere Command R+', provider: 'cohere' },
      { id: 'command-a-vision-07-2025', label: 'Cohere Command A Vision (pictures)', provider: 'cohere' },
    );
  }
  if (!KEYS.openrouter) {
    return res.json({ models: builtin, openrouter: false });
  }
  if (modelCache.list && Date.now() - modelCache.at < 3600000) {
    return res.json({ models: builtin.concat(modelCache.list), openrouter: true });
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: 'Bearer ' + KEYS.openrouter },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const list = (j.data || [])
      .map((m) => ({ id: m.id, label: m.name || m.id, provider: 'openrouter' }))
      .sort((a, b) => a.label.localeCompare(b.label));
    modelCache = { at: Date.now(), list };
    return res.json({ models: builtin.concat(list), openrouter: true });
  } catch (e) {
    return res.json({ models: builtin, openrouter: true, note: 'model list unavailable' });
  }
});

/* What the page needs to know without being told any secrets. */
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: aiEnabled(),
    vision: live('gemini') || live('cohere'),
    providers: Object.keys(KEYS).filter(live),
    personalities: Object.keys(PERSONALITIES).map((k) => ({ id: k, label: PERSONALITIES[k].label || k })),
  });
});

/* For other routes (routes/xenon.js: the chat bot, AI themes, songs): one
   answer from whichever provider is up, same fallback order as /chat. */
export async function askAI(messages, timeoutMs = 25000) {
  if (settings().aiOff || !aiEnabled()) throw new Error('the AI is off');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (const p of ['groq', 'cohere', 'openrouter', 'gemini']) {
      if (!live(p)) continue;
      try {
        let text;
        if (p === 'openrouter') text = await viaOpenRouter(messages, '', ctl.signal);
        else if (p === 'groq') text = await viaGroq(messages, '', ctl.signal);
        else if (p === 'cohere') text = await viaCohere(messages, '', ctl.signal, '');
        else text = await viaGemini(messages, '', '', ctl.signal);
        if (text && text.trim() && !looping(text)) return text.trim();
      } catch (e) {
        if (ctl.signal.aborted) break;
      }
    }
    throw new Error(ctl.signal.aborted ? 'the model took too long' : 'no provider could answer');
  } finally {
    clearTimeout(timer);
  }
}

export default router;
