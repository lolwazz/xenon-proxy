import express from 'express';

const router = express.Router();

/* Search suggestions for the home screen pill.
 *
 * DuckDuckGo's autocomplete endpoint sends no CORS headers, so the page
 * cannot call it directly - this relays it. Results are cached briefly
 * because typing fires a request per keystroke and the same prefixes repeat
 * constantly.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const MAX_CACHE = 500;

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!q) return res.json([]);

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return res.json(hit.v);

  try {
    const r = await fetch('https://duckduckgo.com/ac/?type=list&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return res.json([]);
    const body = await r.json();
    /* type=list answers [query, [suggestions]]; the other shape is a list of
       {phrase} objects. Accept either rather than guessing. */
    let out = [];
    if (Array.isArray(body) && Array.isArray(body[1])) out = body[1];
    else if (Array.isArray(body)) out = body.map((x) => (x && x.phrase) || '').filter(Boolean);
    out = out.filter((s) => typeof s === 'string').slice(0, 8);

    cache.set(key, { at: Date.now(), v: out });
    if (cache.size > MAX_CACHE) {
      /* Cheapest possible eviction: drop the oldest inserted key. */
      cache.delete(cache.keys().next().value);
    }
    return res.json(out);
  } catch {
    /* A suggestion list is a nicety - never surface an error for it. */
    return res.json([]);
  }
});

export default router;
