/* "Watch me play" (2026-11-07): every game page gets xn-watch.js
 * (scripts/games-pages/xn-watch.js), which sits idle until someone on Xenon
 * watches that player. Used by build-games-pages.mjs for the games site and
 * by server.js for game pages served from here.
 *
 * Works on the page as a latin1 string, so every byte survives whatever the
 * page's encoding. The tag goes right after <head> (or <html>, or the
 * doctype): a tag in front of the doctype would drop the page into quirks
 * mode. */
export const WATCH_TAG = '<script src="/xn-watch.js" async></script>';

export function withWatch(s) {
  if (s.includes(WATCH_TAG)) return s;
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + WATCH_TAG + s.slice(m.index + m[0].length);
  }
  return WATCH_TAG + s;
}
