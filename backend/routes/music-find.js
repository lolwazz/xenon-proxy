/**
 * Better audio matching than the upstream fuzzy lookup.
 *
 * The upstream /play/it0 branch asks SoundCloud for a title+artist and takes
 * whatever comes back first, which is very often a remix, a sped-up edit or a
 * cover, because those are what SoundCloud actually hosts for popular songs.
 *
 * This route searches SoundCloud itself and *scores* the candidates: an exact
 * title match and a matching uploader score well, and anything that looks like
 * a derivative work is heavily penalised - unless the search itself asked for
 * one ("x remix" should still find the remix).
 *
 * Audio is returned as a token for the upstream media proxy, so playback stays
 * on our own origin.
 */
import express from 'express';
import fetch from 'node-fetch';
import { mediaProxyPath } from './music-media.js';

const router = express.Router();
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let clientId = null;
let clientIdAt = 0;

// SoundCloud does not publish a client_id, so lift it out of their own bundles.
async function resolveClientId() {
  if (clientId && Date.now() - clientIdAt < 6 * 60 * 60 * 1000) return clientId;
  const home = await fetch('https://soundcloud.com', { headers: { 'User-Agent': UA } });
  const html = await home.text();
  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1]);
  for (const src of scripts.reverse()) {
    try {
      const js = await (await fetch(src, { headers: { 'User-Agent': UA } })).text();
      const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{24,})"/);
      if (m) { clientId = m[1]; clientIdAt = Date.now(); return clientId; }
    } catch { /* try the next bundle */ }
  }
  return null;
}

// Words that mark a track as somebody's rework rather than the release itself.
const DERIVATIVE =
  /\b(remix|rmx|cover|sped\s*up|speed\s*up|slowed|reverb|nightcore|daycore|8d|mashup|bootleg|flip|edit|karaoke|instrumental|acapella|a\s*cappella|type\s*beat|tribute|loop|extended|mix|live|snippet|preview|teaser|ai)\b/i;

const norm = (s) =>
  String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function score(cand, wantTitle, wantArtist) {
  const title = String(cand.title || '');
  const t = norm(title);
  const user = norm(cand.user && cand.user.username);
  const wt = norm(wantTitle);
  const wa = norm(wantArtist);
  let s = 0;

  if (t === wt) s += 70;
  else if (wt && t.includes(wt)) s += 45;
  else if (wt && wt.includes(t) && t.length > 3) s += 20;

  if (wa) {
    if (user.includes(wa) || wa.includes(user)) s += 35;
    else if (t.includes(wa)) s += 18;
  }

  // Only punish derivatives when the caller did not ask for one.
  if (!DERIVATIVE.test(wantTitle) && DERIVATIVE.test(title)) s -= 80;

  // Prefer things that look like a released song rather than a DJ set.
  const secs = (cand.duration || 0) / 1000;
  if (secs > 60 && secs < 480) s += 12;
  if (secs > 900) s -= 25;

  if (cand.policy === 'BLOCK') s -= 200;
  s += Math.min(18, Math.log10((cand.playback_count || 1) + 1) * 4);
  return s;
}

async function progressiveUrl(track, cid) {
  const list = (track.media && track.media.transcodings) || [];
  const pick =
    list.find((x) => x.format && x.format.protocol === 'progressive') || list[0];
  if (!pick) return null;
  const r = await fetch(`${pick.url}?client_id=${cid}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.url ? j.url : null;
}

router.get('/', async (req, res) => {
  const title = String(req.query.t || '').slice(0, 120).trim();
  const artist = String(req.query.a || '').slice(0, 120).trim();
  if (!title) return res.status(400).json({ error: 'missing t' });

  try {
    const cid = await resolveClientId();
    if (!cid) return res.status(503).json({ error: 'no client id' });

    const q = encodeURIComponent(`${title} ${artist}`.trim());
    const sr = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${q}&limit=25&client_id=${cid}`,
      { headers: { 'User-Agent': UA } },
    );
    if (!sr.ok) return res.status(502).json({ error: 'search failed' });
    const found = ((await sr.json()).collection || []).filter((x) => x && x.id);
    if (!found.length) return res.json({ found: false });

    const ranked = found
      .map((c) => ({ c, s: score(c, title, artist) }))
      .sort((a, b) => b.s - a.s);

    for (const { c, s } of ranked.slice(0, 5)) {
      const url = await progressiveUrl(c, cid).catch(() => null);
      if (!url) continue;
      return res.json({
        found: true,
        score: s,
        derivative: DERIVATIVE.test(c.title || ''),
        audioUrl: mediaProxyPath(url),
        track: {
          title: c.title,
          artist: (c.user && c.user.username) || artist,
          duration: c.duration,
          artwork: c.artwork_url || null,
        },
      });
    }
    res.json({ found: false });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err).slice(0, 120) });
  }
});

export default router;
