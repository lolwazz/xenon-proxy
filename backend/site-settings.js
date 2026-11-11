import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

/* Switches the admin panel flips and the rest of the server reads: chat
 * lock / slow mode / word filter / bans / pinned message, the site banner,
 * maintenance mode, voice lock, AI off. One small JSON file. */

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'site-settings.json');

const DEFAULTS = {
  chatLocked: false,
  slowSec: 0,
  words: [],                 // lower-case words starred out of chat
  bannedNames: [],           // lower-case display names
  bannedDevices: [],         // ipHash values (never raw addresses)
  pinned: '',
  announce: { text: '', level: 'info' },
  maintenance: { on: false, text: '' },
  voiceLocked: false,
  aiOff: false,
  salt: '',
};

let S = { ...DEFAULTS };
try { if (existsSync(FILE)) S = { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch {}
/* Device bans compare salted hashes of the address, so the settings file
   never holds anyone's IP. */
if (!S.salt) { S.salt = randomBytes(16).toString('hex'); save(); }

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE + '.tmp', JSON.stringify(S, null, 1));
    renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('[settings] could not save: ' + e.message); }
}

export const settings = () => S;
export function setSettings(patch) { S = { ...S, ...patch }; save(); return S; }

export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
export function ipHash(ip) {
  return createHash('sha256').update(S.salt + '|' + ip).digest('hex').slice(0, 16);
}
