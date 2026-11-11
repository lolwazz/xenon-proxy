// /cdn/<host>/<path>: the proxy's fetch-through for game files kept on public
// CDNs, run at Cloudflare's edge instead. Same allowlist and the same content
// type fixes as server.js.
const HOSTS = [
  /^cdn\.jsdelivr\.net$/i,
  /^(raw|bb)cdn\.githack\.com$/i,
  /^cdn\.statically\.io$/i,
  /^raw\.githubusercontent\.com$/i,
];
const TYPES = {
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  wasm: 'application/wasm', css: 'text/css', html: 'text/html',
  data: 'application/octet-stream', unityweb: 'application/octet-stream',
  mem: 'application/octet-stream', symbols: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};

/* jsDelivr refuses these GitHub users now; their repos are still on GitHub.
   Same list as backend/cdn-unblock.js in the proxy. */
const BLOCKED_USERS = ['genizy', 'gn-math', 'tty67hlt6jf6'];
const BLOCKED_RE = new RegExp('https?://cdn\\.jsdelivr\\.net/gh/(' + BLOCKED_USERS.join('|') + ')/([^/@"\'\\s)]+)(?:@([^/"\'\\s)]+))?/', 'gi');
function unblockText(s) {
  if (!s.includes('cdn.jsdelivr.net/gh/')) return s;
  return s.replace(BLOCKED_RE, (_, user, repo, ref) => '/cdn/raw.githubusercontent.com/' + user + '/' + repo + '/' + (ref || 'HEAD') + '/');
}
function unblockTarget(href) {
  const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)(?:@([^/]+))?\/(.*)$/i.exec(href);
  if (!m || !BLOCKED_USERS.includes(m[1].toLowerCase())) return href;
  return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + (m[3] || 'HEAD') + '/' + m[4];
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/cdn\/+/, '');
  const slash = rest.indexOf('/');
  if (slash < 1) return new Response('bad path', { status: 400 });
  const host = rest.slice(0, slash);
  if (!HOSTS.some((re) => re.test(host))) return new Response('host not allowed', { status: 403 });

  const upstream = await fetch(unblockTarget('https://' + rest) + url.search, {
    redirect: 'follow',
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  const headers = new Headers();
  const ext = (url.pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
  const given = upstream.headers.get('content-type') || '';
  const guessed = ext ? TYPES[ext.toLowerCase()] : null;
  const type = (!given || /^text\/plain/i.test(given)) && guessed ? guessed : given;
  headers.set('Content-Type', type);
  headers.set('Cache-Control', 'public, max-age=604800');
  headers.set('Access-Control-Allow-Origin', '*');
  /* Scripts, pages and styles can ask jsDelivr for more files from a blocked
     user; send those through here too. Latin1 keeps every byte as it was. */
  if (/javascript|json|css|html/i.test(type)) {
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    s = unblockText(s);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return new Response(out, { status: 200, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}
