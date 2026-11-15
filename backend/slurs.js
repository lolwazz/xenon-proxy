/* Shared slur filter (2026-11-15), used by the chat and the online list
   (presence) so both block the same names. Moved here from routes/chat.js. */
/* Built-in slur block (2026-11-15). The admin word list was empty, so slurs
   went through in names and messages. These are always on: a name with one is
   refused, and in messages they are starred out. Look-alike spellings
   (n1gg3r, f@g) are folded before matching. */
const SLURS = ['nigger', 'nigga', 'nigg', 'faggot', 'fagot', 'fag', 'retard', 'tard', 'tranny', 'chink', 'spic', 'kike', 'wetback', 'coon', 'beaner', 'gook', 'raghead', 'towelhead', 'dyke', 'paki', 'redskin'];
const FOLD = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };
const fold = (s) => String(s).toLowerCase().replace(/[013457@$!|8]/g, (c) => FOLD[c] || c);
/* Short words (coon, spic, fag...) only as whole words, so "raccoon" or
   "spicy" still pass; long ones match anywhere, separators ignored. */
/* 2026-11-15 (second raid): zalgo marks are stripped first, and each text is
   also checked with digits turned into spaces - folding "spic88" into
   "spicbb" had hidden the word boundary, so lil_spic88 got through. */
export const plain = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '');
export function hasSlur(s) {
  const base = plain(s);
  for (const f of [fold(base), base.toLowerCase().replace(/[0-9_]/g, ' ')]) {
    const squashed = f.replace(/[^a-z]/g, '');
    const words = f.match(/[a-z]+/g) || [];
    for (const w of SLURS) {
      if (w.length >= 6 || w === 'nigg' || w === 'nigga') { if (squashed.includes(w)) return true; }
      /* short ones: at the start of a word, so junk glued on the end
         (spicxx, chinkxd) doesn't hide them; real words that start the same
         way are let through */
      else if (words.some((x) => x.startsWith(w) && !SAFE_START.some((ok) => x.startsWith(ok)))) return true;
    }
  }
  return false;
}
const SAFE_START = ['spicy', 'spice', 'spici', 'pakistan', 'tardis', 'tardy', 'tardi', 'coonhound', 'faggio', 'gookie'];
/* Spam shapes the raid used: @everyone from non-staff, walls of random
   characters, one phrase repeated over and over. */
function spamShape(text) {
  if (/@(everyone|here)\b/i.test(text)) return 'only staff can ping everyone';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.some((w) => w.length > 60 && !/^https?:\/\//i.test(w))) return 'that looks like spam';
  if (words.length >= 12 && new Set(words.map((w) => w.toLowerCase())).size / words.length < 0.35) return 'that looks like spam';
  return '';
}

/* Raid mode (2026-11-15): the second raid came from 26 addresses with ~5
   messages each, under every per-address limit. So watch the whole chat:
   if brand-new profiles (first message under 10 minutes ago) send more than
   10 messages in a minute, new profiles can't post for 15 minutes. People
   who chatted before keep chatting. */
const freshHits = [];
let raidUntil = 0;
function isFresh(pid) {
  const p = people.get(pid);
  return !p || (p.first && Date.now() - p.first < 10 * 60000);
}
function raidCheck(pid) {
  const now = Date.now();
  if (!isFresh(pid)) return '';
  if (raidUntil > now) return 'chat is in raid mode - new accounts can post again in a few minutes';
  while (freshHits.length && now - freshHits[0] > 60000) freshHits.shift();
  freshHits.push(now);
  if (freshHits.length > 10) {
    raidUntil = now + 15 * 60000;
    freshHits.length = 0;
    console.log('[chat] raid mode on for 15 minutes');
    try { sysMessage(general, 'Raid mode is on for 15 minutes - new accounts can\'t post. Everyone else is fine.'); } catch {}
    return 'chat is in raid mode - new accounts can post again in a few minutes';
  }
  return '';
}
