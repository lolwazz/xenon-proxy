// froggy.zpack.beauty: the same proxy, dressed as Froggy.
//
// Any request whose Host starts with "froggy." gets the proxy page and its
// stylesheet rewritten on the way out - green instead of blue, the frog
// mascot instead of the Xenon wordmark. Everything else (service worker,
// transports, games) is shared untouched, so the two can never drift.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// browser.css colour -> Froggy colour. Blues and purples become greens;
// the dark navy surfaces become dark pond-greens. Gold, red and the "ok"
// green are left alone so warnings still read as warnings.
const SWAP = [
  ['rgba(143,184,255', 'rgba(110,232,96'], ['rgba(150,185,255', 'rgba(130,228,118'],
  ['rgba(177,140,255', 'rgba(196,255,110'], ['rgba(120,160,255', 'rgba(96,214,84'],
  ['rgba(90,120,255', 'rgba(62,196,58'], ['rgba(70,100,230', 'rgba(40,160,46'],
  ['rgba(122,162,255', 'rgba(98,216,88'], ['rgba(170,205,255', 'rgba(170,242,158'],
  ['rgba(216,231,255', 'rgba(222,247,214'], ['rgba(205,222,255', 'rgba(212,245,200'],
  ['rgba(238,243,255', 'rgba(236,251,232'], ['rgba(5,7,14', 'rgba(4,10,5'],
  ['rgba(10,17,32', 'rgba(9,22,11'], ['rgba(11,18,34', 'rgba(10,24,12'],
  ['rgba(14,22,40', 'rgba(13,30,15'], ['rgba(12,22,40', 'rgba(12,28,14'],
  ['rgba(10,16,30', 'rgba(9,21,10'], ['rgba(2,4,10', 'rgba(2,6,2'],
  ['#8fb8ff', '#6ee860'], ['#b18cff', '#c4ff6e'], ['#05070e', '#040a05'],
  ['#eef3ff', '#eefbe9'], ['#cfe0ff', '#d4f5cc'], ['#b9cdf0', '#bde8b2'],
  ['#c9b4ff', '#d6ff9a'], ['#08101f', '#071408'], ['#eaf1ff', '#eafbe5'],
  ['#dfe9ff', '#dcf7d4'], ['#b9b0ff', '#c8f59a'], ['#7aa2ff', '#5fd25a'],
  ['#0b1626', '#0a1a0c'],
];

function skinCss(css) {
  for (const [a, b] of SWAP) css = css.split(a).join(b);
  return css;
}

function skinHtml(html) {
  const mascot = (n) => '<img class="fr-mascot" src="/froggy/frog.webp" alt="" width="' + n + '" height="' + n + '">';
  const rep = (from, to) => {
    if (!html.includes(from)) throw new Error('froggy: index.html changed, missing ' + from);
    html = html.split(from).join(to);
  };
  rep('<title>Xenon</title>', '<title>Froggy</title>');
  rep('<link rel="icon" href="/brand/xenon-32.png" sizes="32x32">', '<link rel="icon" href="/froggy/frog.webp">');
  rep('<link rel="icon" href="/brand/xenon-192.png" sizes="192x192">', '<meta name="theme-color" content="#0a1a0c">');
  rep('<link rel="apple-touch-icon" href="/brand/xenon-180.png">', '<link rel="apple-touch-icon" href="/froggy/frog.webp">');
  rep('<link rel="stylesheet" href="/browser.css?v=3">',
    // skin=froggy so the green stylesheet is also served on non-froggy hosts
    '<link rel="stylesheet" href="/browser.css?v=3&amp;skin=froggy">\n' +
    '<link rel="preload" href="/froggy/pusab.otf" as="font" type="font/otf" crossorigin>\n' +
    '<link rel="stylesheet" href="/froggy/froggy.css?v=2">');
  rep('<h1>xenon</h1>', mascot(150) + '\n  <h1 class="fr-title">froggy</h1>');
  rep('<h2 class="ntp-logo">xenon</h2>',
    '<div class="ntp-hero">' + mascot(128) + '<h2 class="ntp-logo fr-title">froggy</h2></div>');
  // poke the frog and it hops
  rep('</body>', '<script>document.addEventListener("click",function(e){var f=e.target.closest&&e.target.closest(".fr-mascot");if(!f)return;f.classList.remove("hop");void f.offsetWidth;f.classList.add("hop");});document.addEventListener("animationend",function(e){if(e.animationName==="fr-hop")e.target.classList.remove("hop");});</script>\n</body>');
  return html;
}

// Re-skin only when the source file changes, not on every request.
function cached(file, fn) {
  let mtime = 0, out = '';
  return () => {
    const m = statSync(file).mtimeMs;
    if (m !== mtime) { out = fn(readFileSync(file, 'utf8')); mtime = m; }
    return out;
  };
}

export function froggy(publicDir) {
  const page = cached(join(publicDir, 'index.html'), skinHtml);
  const css = cached(join(publicDir, 'browser.css'), skinCss);
  return (req, res, next) => {
    // froggy.* hosts, or ?skin=froggy on any host - the second works on a
    // network whose DNS has not caught up with the froggy record yet.
    const host = /^froggy\./i.test(req.hostname || '');
    if (!host && req.query.skin !== 'froggy') return next();
    // Service workers only exist on https, so a visitor who typed or was
    // linked to http:// would just see "needs https". Cloudflare tells us
    // the scheme the visitor used; send them to the https copy.
    if (host && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'http'
        && !/\.localhost$/i.test(req.hostname)) {
      return res.redirect(301, 'https://' + req.hostname + req.originalUrl);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/' || req.path === '/index.html') {
      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.send(page());
    }
    if (req.path === '/browser.css') {
      res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.send(css());
    }
    next();
  };
}
