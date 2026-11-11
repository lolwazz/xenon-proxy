/* jsDelivr refuses whole GitHub users now ("User X is blocked", 403), and
 * the games from those users went dark (2026-11-07). Their repositories are
 * still on GitHub, so the same files come from raw.githubusercontent through
 * this server's /cdn route instead. Used by server.js /cdn (the Pages copy
 * in scripts/games-pages/functions/cdn has the same list) and by
 * scripts/unblock-jsdelivr.mjs, which rewrote the game pages.
 *
 * AndreajnRcm4 is blocked too, but its repo was deleted (and the games only
 * took a stylesheet from it), so there is nothing to fetch. */
export const BLOCKED_USERS = ['genizy', 'gn-math', 'tty67hlt6jf6'];

const RE = new RegExp('https?://cdn\\.jsdelivr\\.net/gh/(' + BLOCKED_USERS.join('|') + ')/([^/@"\'\\s)]+)(?:@([^/"\'\\s)]+))?/', 'gi');

/** Every blocked jsDelivr address in a text file, pointed at /cdn + GitHub raw. */
export function unblockText(s) {
  if (!s.includes('cdn.jsdelivr.net/gh/')) return s;
  return s.replace(RE, (_, user, repo, ref) => '/cdn/raw.githubusercontent.com/' + user + '/' + repo + '/' + (ref || 'HEAD') + '/');
}

/** A /cdn target on jsDelivr for a blocked user, as the GitHub raw address. */
export function unblockTarget(href) {
  const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)(?:@([^/]+))?\/(.*)$/i.exec(href);
  if (!m || !BLOCKED_USERS.includes(m[1].toLowerCase())) return href;
  return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + (m[3] || 'HEAD') + '/' + m[4];
}
