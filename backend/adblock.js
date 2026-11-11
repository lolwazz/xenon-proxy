/**
 * Request-level ad and tracker blocking.
 *
 * Everything proxied - Ultraviolet and Scramjet alike - goes out through the
 * bare server, so filtering there catches ads for every site at once rather
 * than per page. Blocked requests get an empty 204 instead of an error, which
 * pages handle far more gracefully than a failed fetch.
 */

// Matched against the hostname. Kept as suffixes so subdomains are covered.
const BLOCKED_SUFFIXES = [
  // Google ad and measurement
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'pagead2.googlesyndication.com',
  // Google's video ad player (IMA). Through the proxy its messages arrive
  // mangled, so it never says "ad done" or "no ad" - GameDistribution games
  // then wait on a black screen forever. Blocked, the SDK sees no ad player
  // and starts the game.
  'imasdk.googleapis.com',
  // GameDistribution's pre-game ad auction. Through the proxy the auction
  // request never returns, and the game waits black for it indefinitely.
  'headerlift.com', 'improvedigital.com',
  // Big exchanges and networks
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  'casalemedia.com', 'indexexchange.com', 'criteo.com', 'criteo.net',
  'smartadserver.com', 'districtm.io', 'sharethrough.com', 'teads.tv',
  '33across.com', 'bidswitch.net', 'rlcdn.com', 'agkn.com',
  // Pop-under / aggressive networks, the kind streaming sites use
  'popads.net', 'popcash.net', 'propellerads.com', 'propellerpops.com',
  'exoclick.com', 'exosrv.com', 'juicyads.com', 'adsterra.com',
  'hilltopads.net', 'clickadu.com', 'adcash.com', 'trafficjunky.net',
  'mgid.com', 'revcontent.com', 'zedo.com', 'bidvertiser.com',
  'admaven.com', 'onclickalgo.com', 'onclckds.com', 'pushnative.com',
  'trafficfactory.biz', 'popunder.net', 'adsco.re', 'admatic.com',
  // Analytics and session recording
  'scorecardresearch.com', 'quantserve.com', 'chartbeat.com', 'hotjar.com',
  'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com',
  'fullstory.com', 'clarity.ms', 'mouseflow.com', 'crazyegg.com',
  'yandex.ru', 'mc.yandex.ru', 'matomo.cloud',
  'moatads.com', 'adsafeprotected.com', 'doubleverify.com',
];

// Some ad chains hop through throwaway domains. These TLDs are almost never
// used by anything a person actually wants, and were seen in the pop-unders
// this site threw.
// .cfd removed: the owner's own site lives on that TLD, and blocking it here
// would break any proxied request back to their own domain.
const BLOCKED_TLDS = ['.qpon', '.icu', '.sbs', '.rest', '.bond'];

// Path markers that identify ad calls even on otherwise-legitimate hosts.
const BLOCKED_PATHS = [
  '/pagead/', '/adsbygoogle', '/gampad/', '/ad_status', '/pcs/activeview',
  '/generate_204?', '/adframe', '/adserver', '/popunder', '/prebid',
];

export function isBlocked(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  const host = u.hostname.toLowerCase();

  for (const suffix of BLOCKED_SUFFIXES) {
    if (host === suffix || host.endsWith('.' + suffix)) return true;
  }
  for (const tld of BLOCKED_TLDS) {
    if (host.endsWith(tld)) return true;
  }
  const path = (u.pathname + u.search).toLowerCase();
  for (const marker of BLOCKED_PATHS) {
    if (path.includes(marker)) return true;
  }
  return false;
}

export const stats = { blocked: 0, allowed: 0 };
