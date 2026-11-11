// /flash/<file>.swf: a page that boots Ruffle and fills the screen, same as
// the proxy's route, so the Flash games link here like any other game.
export function onRequestGet({ params }) {
  const file = String(params.file || '');
  if (!/^[\w.-]+\.swf$/i.test(file)) return new Response('bad file', { status: 400 });
  const title = file.replace(/\.swf$/i, '');
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><script src="/clip-agent.js"></script><script src="/xn-watch.js" async></script><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#player{width:100vw;height:100vh}</style>
<script src="/ruffle/ruffle.js"></script>
</head><body>
<div id="player"></div>
<script>
  window.RufflePlayer = window.RufflePlayer || {};
  window.RufflePlayer.config = { autoplay: 'on', unmuteOverlay: 'hidden', letterbox: 'on', contextMenu: 'off', warnOnUnsupportedContent: false };
  window.addEventListener('load', function () {
    var player = window.RufflePlayer.newest().createPlayer();
    document.getElementById('player').appendChild(player);
    player.style.width = '100%';
    player.style.height = '100%';
    player.load('/g/flash/${encodeURIComponent(file)}');
  });
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
}
