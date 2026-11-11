/* Xeunes: the music app at /xeunes/ on the portal (a rebuilt Monochrome).
 *
 * Monochrome gets song info from TIDAL and full songs from its own servers.
 * TIDAL's public client only ever hands out 30-second previews, and
 * Monochrome's song servers went down on 2026-11-05 (522 from Cloudflare), so
 * Xeunes keeps TIDAL for search, covers and albums and gets the songs here:
 *
 *   GET /api/xe/match?t=&a=&al=&d=   the matching song on YouTube Music
 *                                    (official audio, same length), with
 *                                    its stream already looked up
 *   GET /api/xe/a/<videoId>          that song's audio, streamed through
 *                                    this PC. The address never changes:
 *                                    the upstream link expires after a few
 *                                    hours and is looked up again here, so
 *                                    the portal's dock can keep playing it
 *                                    on any page.
 *   GET|POST /api/xe/t?u=<url>       TIDAL's API, relayed, because school
 *                                    filters block tidal.com. Allowlisted.
 *
 * Streams come from yt-dlp (installed with Python on this PC). Upstream
 * links are tied to the address that asked for them, which is this PC, so
 * the audio has to come through here rather than straight from Google.
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fetch from 'node-fetch';

const router = express.Router();
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------- small helpers ---------- */

function clean(s, max = 160) {
  return String(s || '').replace(/[\u0000-\u001f<>{}\\]/g, '').trim().slice(0, max);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[([](feat|ft|with)\.?[^)\]]*[)\]]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function remember(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

/* Per network, not per person: behind the Cloudflare tunnel req.ip is this
   PC for everyone, and a whole school shares one public address, so the
   limits are sized for a classroom. What keeps yt-dlp from swamping the PC
   is the three-at-a-time queue further down; this only stops a runaway tab. */
function ipOf(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
}
const hits = new Map();
function tooMany(ip, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  remember(hits, ip, list, 5000);
  return list.length > limit;
}

/* ---------- YouTube Music search ---------- */

function seconds(text) {
  const p = String(text || '').split(':').map((n) => parseInt(n, 10));
  if (p.some((n) => Number.isNaN(n))) return 0;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

/* The "Songs" filter on music.youtube.com: official album audio only, which
   is what a TIDAL track is. */
const SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

async function ytmSongs(query) {
  const r = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en', gl: 'US' } },
      query,
      params: decodeURIComponent(SONGS),
    }),
    timeout: 12000,
  });
  if (!r.ok) return [];
  const data = await r.json();
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object' || out.length >= 12) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const it = n.musicResponsiveListItemRenderer;
    if (it) {
      const cols = (it.flexColumns || []).map((c) =>
        (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map((x) => x.text).join('')
      );
      const vid =
        it.playlistItemData?.videoId ||
        it.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
          ?.watchEndpoint?.videoId;
      if (vid && /^[\w-]{11}$/.test(vid)) {
        /* Second column reads "Artist • Album • 3:22". */
        const meta = String(cols[1] || '').split(' • ');
        out.push({
          vid,
          title: cols[0] || '',
          artist: meta[0] || '',
          album: meta.length > 2 ? meta[1] : '',
          dur: seconds(meta[meta.length - 1]),
        });
      }
      return;
    }
    for (const v of Object.values(n)) walk(v);
  })(data);
  return out;
}

/* Versions nobody asked for. Each only counts against a result when the
   wanted title does not say it too. */
const OTHER_VERSION =
  /\b(live|remix|cover|karaoke|instrumental|sped up|slowed|nightcore|8d|reverb|acoustic|version|tribute|piano|lofi|lo fi|reprise|edit|mix|clean|extended)\b/;

function score(c, want) {
  const tw = norm(want.t);
  const tc = norm(c.title);
  let s = 0;
  if (tc === tw) s += 50;
  else if (tc.startsWith(tw) || tw.startsWith(tc)) s += 32;
  else {
    const a = new Set(tw.split(' '));
    const b = tc.split(' ');
    const shared = b.filter((w) => a.has(w)).length;
    s += Math.round((shared / Math.max(a.size, b.length, 1)) * 28);
  }
  const wantArtists = norm(want.a).split(/\band\b|,/).map((x) => x.trim()).filter(Boolean);
  const ca = norm(c.artist);
  if (wantArtists.length && wantArtists.some((x) => ca.includes(x) || x.includes(ca))) s += 30;
  if (want.al && c.album && norm(c.album) === norm(want.al)) s += 10;
  if (want.d && c.dur) {
    const diff = Math.abs(c.dur - want.d);
    if (diff <= 2) s += 25;
    else if (diff <= 5) s += 15;
    else if (diff <= 10) s += 5;
    else if (diff > 30) s -= 40;
  }
  for (const word of tc.match(new RegExp(OTHER_VERSION.source, 'g')) || []) {
    if (!tw.includes(word)) s -= 30;
  }
  return s;
}

const matchCache = new Map();
async function findSong(want) {
  const key = norm(want.t) + '|' + norm(want.a) + '|' + (want.d || 0);
  const hit = matchCache.get(key);
  if (hit && Date.now() - hit.at < 864e5) return hit.song;

  const firstArtist = String(want.a || '').split(/,|&| x | feat\.? /i)[0].trim();
  let found = await ytmSongs(`${firstArtist} ${want.t}`.trim()).catch(() => []);
  let best = null;
  let bestScore = -1e9;
  for (const c of found) {
    const sc = score(c, want);
    if (sc > bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  /* A title alone sometimes finds what title-plus-artist missed (artists
     credited differently on the two services). */
  if (bestScore < 55) {
    found = await ytmSongs(String(want.t)).catch(() => []);
    for (const c of found) {
      const sc = score(c, want);
      if (sc > bestScore) {
        best = c;
        bestScore = sc;
      }
    }
  }
  const song = best && bestScore >= 45 ? { ...best, score: bestScore } : null;
  remember(matchCache, key, { at: Date.now(), song }, 3000);
  return song;
}

/* ---------- stream links (yt-dlp) ---------- */

const YTDLP =
  [process.env.YTDLP_PATH, 'C:/Users/mooma/AppData/Local/Programs/Python/Python312/Scripts/yt-dlp.exe'].find(
    (p) => p && existsSync(p)
  ) || 'yt-dlp';

const links = new Map(); // videoId -> { url, exp }
const pending = new Map(); // videoId -> Promise
const waiting = [];
let running = 0;
const MAX_RUNNING = 3;

function runYtdlp(vid) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      YTDLP,
      ['-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio', '-g', '--no-warnings', '--no-playlist', '--', vid],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('yt-dlp timed out'));
    }, 30000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const url = out.split(/\r?\n/).find((l) => l.startsWith('https://'));
      if (code === 0 && url) resolve(url);
      else reject(new Error((err.split(/\r?\n/).filter(Boolean).pop() || 'yt-dlp failed').slice(0, 200)));
    });
  });
}

function nextInLine() {
  while (running < MAX_RUNNING && waiting.length) {
    const job = waiting.shift();
    running++;
    runYtdlp(job.vid)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        nextInLine();
      });
  }
}

async function streamLink(vid, fresh = false) {
  const have = links.get(vid);
  if (!fresh && have && Date.now() < have.exp) return have.url;
  if (pending.has(vid)) return pending.get(vid);
  const job = new Promise((resolve, reject) => {
    waiting.push({ vid, resolve, reject });
    nextInLine();
  })
    .then((url) => {
      /* The link says when it expires; give it up ten minutes early. */
      let exp = Date.now() + 3 * 3600e3;
      try {
        const e = parseInt(new URL(url).searchParams.get('expire'), 10);
        if (e) exp = e * 1000 - 10 * 60e3;
      } catch {}
      remember(links, vid, { url, exp }, 2000);
      return url;
    })
    .finally(() => pending.delete(vid));
  pending.set(vid, job);
  return job;
}

/* ---------- routes ---------- */

router.get('/match', async (req, res) => {
  const want = {
    t: clean(req.query.t, 200),
    a: clean(req.query.a, 200),
    al: clean(req.query.al, 200),
    d: Math.max(0, Math.min(7200, parseInt(req.query.d, 10) || 0)),
  };
  if (!want.t) return res.status(400).json({ error: 'missing title' });
  if (tooMany('m:' + ipOf(req), 150, 60e3)) return res.status(429).json({ error: 'slow down' });
  try {
    const song = await findSong(want);
    if (!song) return res.status(404).json({ error: 'no full version found' });
    /* Looked up now so the first audio request starts straight away. */
    await streamLink(song.vid);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json({
      vid: song.vid,
      title: song.title,
      artist: song.artist,
      album: song.album,
      dur: song.dur,
      url: '/api/xe/a/' + song.vid,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

/* Google's audio servers answer at most about 1 MB per request (bigger or
   open-ended ranges get 403), while a browser asks for "everything from
   here on". So the browser gets one ordinary response, stitched together
   here from 1 MB slices fetched one after another. */
const SLICE = 1024 * 1024;

function linkInfo(url) {
  try {
    const p = new URL(url).searchParams;
    return { size: parseInt(p.get('clen'), 10) || 0, type: p.get('mime') || 'audio/mp4' };
  } catch {
    return { size: 0, type: 'audio/mp4' };
  }
}

function slice(url, from, to) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', Range: `bytes=${from}-${to}` },
    timeout: 20000,
  });
}

async function sendAudio(req, res) {
  const vid = String(req.params.vid || '');
  if (!/^[\w-]{11}$/.test(vid)) return res.status(400).end();
  let url;
  try {
    url = await streamLink(vid);
  } catch {
    return res.status(502).end();
  }
  let { size, type } = linkInfo(url);

  /* The first slice also proves the link still works; an expired one is
     looked up again once. */
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0;
  let end = size ? size - 1 : SLICE - 1;
  if (m && m[1] !== '') start = parseInt(m[1], 10);
  else if (m && m[2] !== '' && size) start = Math.max(0, size - parseInt(m[2], 10)); // "bytes=-500"
  if (m && m[1] !== '' && m[2] !== '') end = parseInt(m[2], 10);
  if (size) end = Math.min(end, size - 1);
  if (size && start >= size) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  let first;
  try {
    first = await slice(url, start, Math.min(start + SLICE - 1, end));
    if (first.status === 403 || first.status === 410) {
      try { first.body?.destroy?.(); } catch {}
      url = await streamLink(vid, true);
      ({ size, type } = linkInfo(url));
      first = await slice(url, start, Math.min(start + SLICE - 1, end));
    }
  } catch {
    return res.status(502).end();
  }
  if (first.status !== 206 && first.status !== 200) {
    try { first.body?.destroy?.(); } catch {}
    return res.status(502).end();
  }
  /* No size in the link: the slice's Content-Range has it. */
  if (!size) {
    const cr = /\/(\d+)$/.exec(first.headers.get('content-range') || '');
    size = cr ? parseInt(cr[1], 10) : 0;
    end = size ? (m && m[2] !== '' && m[1] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1) : start + SLICE - 1;
  }

  res.status(m ? 206 : 200);
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(end - start + 1));
  if (m) res.setHeader('Content-Range', `bytes ${start}-${end}/${size || '*'}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.method === 'HEAD') {
    try { first.body?.destroy?.(); } catch {}
    return res.end();
  }

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const write = (buf) =>
    new Promise((resolve) => {
      if (res.write(buf)) resolve();
      else res.once('drain', resolve);
    });
  try {
    let up = first;
    let pos = start;
    while (!closed && pos <= end) {
      for await (const buf of up.body) {
        if (closed) break;
        await write(buf);
      }
      pos = Math.min(pos + SLICE - 1, end) + 1;
      if (closed || pos > end) break;
      up = await slice(url, pos, Math.min(pos + SLICE - 1, end));
      if (up.status !== 206 && up.status !== 200) break;
    }
  } catch {
    /* the listener skipped ahead or left: Chrome asks again from the new spot */
  }
  try { res.end(); } catch {}
}
router.get('/a/:vid', sendAudio);
router.head('/a/:vid', sendAudio);

/* TIDAL relay. Responses to the public client are the same for everyone, so
   reads are kept for ten minutes: one search from a class of thirty is one
   request upstream, and TIDAL sees far less of this PC. */
const TIDAL = /^((auth|api|openapi|listen)\.)?tidal\.com$/i;
const tidalCache = new Map();
router.all('/t', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  let target;
  try {
    target = new URL(String(req.query.u || ''));
  } catch {
    return res.status(400).end();
  }
  if (target.protocol !== 'https:' || !TIDAL.test(target.hostname) || target.username || target.password) {
    return res.status(403).end();
  }
  if (tooMany('t:' + ipOf(req), 1500, 60e3)) return res.status(429).end();

  const cacheable = req.method === 'GET' && target.hostname !== 'auth.tidal.com';
  if (cacheable) {
    const hit = tidalCache.get(target.href);
    if (hit && Date.now() - hit.at < 600e3) {
      res.status(hit.status).setHeader('Content-Type', hit.type);
      res.setHeader('X-Xe-Cache', 'hit');
      return res.end(hit.body);
    }
  }
  const headers = { 'User-Agent': UA, Accept: req.headers.accept || 'application/json' };
  for (const k of ['authorization', 'content-type', 'x-tidal-token', 'accept-language']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  try {
    const up = await fetch(target.href, {
      method: req.method,
      headers,
      body: req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
      timeout: 15000,
      redirect: 'follow',
    });
    const body = Buffer.from(await up.arrayBuffer());
    const type = up.headers.get('content-type') || 'application/json';
    if (cacheable && up.ok && body.length < 2e6) {
      remember(tidalCache, target.href, { at: Date.now(), status: up.status, type, body }, 600);
    }
    res.status(up.status).setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.status(502).end();
  }
});

router.get('/health', (_req, res) => res.json({ ok: true, ytdlp: YTDLP !== 'yt-dlp' || 'path' }));

export default router;
