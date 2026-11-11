/* Resolves an official Microsoft download link for the Windows 10 ISO.
 *
 * Microsoft serves the Media Creation Tool, not an ISO, to anything with a
 * Windows user agent - the direct links only appear for other platforms. So
 * this walks the same session flow their page uses: register a session id,
 * read the product edition id off the page, ask for the SKU in the wanted
 * language, then ask for that SKU's links.
 *
 * The links they hand back are tied to the requesting IP and expire in about
 * 24 hours, so this prints one rather than caching it.
 *
 * Usage: node scripts/get-win10-iso.mjs [language]
 */
import crypto from 'node:crypto';

const LANG = process.argv[2] || 'English (United States)';
const PROFILE = '606624d44113';
const SESSION = crypto.randomUUID();

/* A non-Windows UA is the whole trick - with a Windows one the page only
   offers the Media Creation Tool. */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const H = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/* Their anti-bot ("Sentinel") rejects the final call unless the request looks
   like it came from the same browser session that loaded the page, which means
   carrying the cookies it set. Node's fetch keeps none, so this is a jar. */
const jar = new Map();
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function cookieHeader() {
  if (!jar.size) return undefined;
  return [...jar].map(([k, v]) => k + '=' + v).join('; ');
}

async function get(url, extra) {
  const ck = cookieHeader();
  const headers = { ...H, ...(extra || {}) };
  if (ck) headers.Cookie = ck;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(40000) });
  storeCookies(r);
  return { status: r.status, text: await r.text() };
}

const PAGE = 'https://www.microsoft.com/en-us/software-download/windows10ISO';

console.log('  session ' + SESSION);

/* 1. Microsoft ties the later API calls to a session registered here. */
/* Load the page first so its cookies are in the jar, then register the
   session, then give their backend a moment to accept it. */
const warm = await get(PAGE);
console.log('  warmup: HTTP ' + warm.status + '  cookies ' + jar.size);
await get('https://vlscppe.microsoft.com/fp/tags?org_id=y6jn8c31&session_id=' + SESSION).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));

/* 2. The edition id changes with each Windows release, so read it off the page
      rather than hardcoding one that will rot. */
const page = await get(PAGE);
console.log('  download page: HTTP ' + page.status + '  (' + page.text.length + ' bytes)');

const ids = [...page.text.matchAll(/<option[^>]*value=["'](\d{3,5})["'][^>]*>([^<]*)</gi)]
  .map((m) => ({ id: m[1], label: m[2].trim() }))
  .filter((o) => o.label);
if (!ids.length) {
  console.log('  no product editions found - Microsoft changed the page, or served the tool instead');
  console.log('  page mentions "Media Creation": ' + /media creation/i.test(page.text));
  process.exit(1);
}
ids.slice(0, 8).forEach((o) => console.log('    edition ' + o.id + '  ' + o.label.slice(0, 60)));

const edition = ids[ids.length - 1];
console.log('  using edition ' + edition.id + ' (' + edition.label.slice(0, 50) + ')');

/* 3. Languages for that edition. */
const skuUrl =
  'https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition' +
  '?profile=' + PROFILE + '&ProductEditionId=' + edition.id +
  '&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=' + SESSION;
const skuRes = await get(skuUrl, { Referer: PAGE });
let skus;
try { skus = JSON.parse(skuRes.text); } catch { skus = null; }
if (!skus || !skus.Skus) {
  console.log('  sku lookup failed: HTTP ' + skuRes.status + '  ' + skuRes.text.slice(0, 200));
  process.exit(1);
}
const sku = skus.Skus.find((s) => s.LocalizedLanguage === LANG) || skus.Skus[0];
console.log('  language: ' + sku.LocalizedLanguage + '  (sku ' + sku.Id + ')');

/* 4. The actual links. */
const linkUrl =
  'https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku' +
  '?profile=' + PROFILE + '&productEditionId=undefined&SKU=' + sku.Id +
  '&friendlyFileName=undefined&Locale=en-US&sessionID=' + SESSION;
const linkRes = await get(linkUrl, { Referer: PAGE });
let links;
try { links = JSON.parse(linkRes.text); } catch { links = null; }

if (!links || !links.ProductDownloadOptions) {
  console.log('  link lookup failed: HTTP ' + linkRes.status);
  console.log('  ' + linkRes.text.slice(0, 300));
  if (links && links.Errors) console.log('  errors: ' + JSON.stringify(links.Errors).slice(0, 300));
  process.exit(1);
}

console.log('');
links.ProductDownloadOptions.forEach((o) => {
  console.log('  ' + String(o.DownloadType === 0 ? '32-bit' : '64-bit').padEnd(8) + o.Uri.slice(0, 110));
});

const x64 = links.ProductDownloadOptions.find((o) => /x64/i.test(o.Uri)) || links.ProductDownloadOptions[0];
console.log('');
console.log('CHOSEN ' + x64.Uri);
