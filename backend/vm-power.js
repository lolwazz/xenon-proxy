/* VMs only run while someone is using them (owner's request, 2026-11-08:
 * the three VMs kept the CPU ~40% busy around the clock and the power bill
 * went up).
 *
 *  - A VM that is off counts as available: the VM page lets people click it.
 *  - Opening its screen (pc-bridge.js) boots it, and the connection waits
 *    until the desktop answers.
 *  - When the last person leaves, it shuts down after IDLE_MS: the guest gets
 *    a power-button press through QEMU's control port (QMP), and the process
 *    is ended if it is still there STOP_GRACE_MS later.
 *
 * VMs are started the way the Startup shortcuts start them, through WMI, so
 * the QEMU belongs to no one and a proxy restart does not take it down. The
 * Windows watchdog only acts on a running QEMU, so a VM shut down here stays
 * down. */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDLE_MS = 15 * 60 * 1000;
const STOP_GRACE_MS = 120 * 1000;
const BOOT_WAIT_MS = 4 * 60 * 1000;

const GROUPS = {
  win10: { tag: 'xenon-win10', qmp: 4444, start: ['scripts\\start-win10.ps1', '-MemoryMB', '6144'] },
  linux: { tag: 'xenon-linux', qmp: 4446, start: ['scripts\\start-linux.ps1'] },
  android: { tag: 'xenon-android', qmp: 4445, start: ['scripts\\start-android.ps1'] },
};
/* VM page machine -> group. The four Linux desktops are one VM. */
const OF = { win10: 'win10', android: 'android', seat1: 'linux', seat2: 'linux', seat3: 'linux', seat4: 'linux' };

const st = {};
for (const g of Object.keys(GROUPS)) st[g] = { on: false, users: 0, idle: null, stopping: null, booting: null };

function ps(cmd) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 30000 },
      (err, out) => resolve(err ? '' : String(out || '')));
  });
}

/* Which VMs have a QEMU process right now. */
async function refresh() {
  const out = await ps("Get-CimInstance Win32_Process -Filter \"Name='qemu-system-x86_64.exe'\" | ForEach-Object { $_.CommandLine }");
  for (const [g, v] of Object.entries(GROUPS)) st[g].on = out.includes(v.tag);
  return st;
}

function qmp(port, cmd) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const w = (o) => s.write(JSON.stringify(o) + '\n');
    s.on('connect', () => {
      w({ execute: 'qmp_capabilities' });
      setTimeout(() => w({ execute: cmd }), 200);
      setTimeout(() => { s.destroy(); resolve(true); }, 700);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(3000, () => { s.destroy(); resolve(false); });
  });
}

function boot(g) {
  const v = GROUPS[g];
  const line = 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + v.start.map((a, i) => (i === 0 ? '"' + join(ROOT, a) + '"' : a)).join(' ');
  const esc = line.replace(/'/g, "''");
  console.log('[vm-power] starting ' + g);
  return ps(`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${esc}'; CurrentDirectory = '${ROOT.replace(/'/g, "''")}' } | Out-Null`);
}

async function stop(g) {
  const s = st[g];
  if (s.stopping) return s.stopping;
  s.stopping = (async () => {
    console.log('[vm-power] nobody on ' + g + ' for ' + IDLE_MS / 60000 + ' min - shutting it down');
    await qmp(GROUPS[g].qmp, 'system_powerdown');
    const until = Date.now() + STOP_GRACE_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000));
      await refresh();
      if (!s.on) break;
      if (s.users > 0) break;   // someone came back while it was shutting down
    }
    if (s.on && s.users === 0) {
      /* The guest ignored the power button (Android does): end the process. */
      await ps(`Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '${GROUPS[g].tag}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
      await refresh();
    }
    s.stopping = null;
  })();
  return s.stopping;
}

function armIdle(g) {
  const s = st[g];
  clearTimeout(s.idle);
  s.idle = null;
  if (s.users === 0 && s.on) s.idle = setTimeout(() => { s.idle = null; if (s.users === 0) stop(g); }, IDLE_MS);
}

/** True when this machine is managed here and its VM is off (or booting). */
export function asleep(machine) {
  const g = OF[machine];
  return Boolean(g && (!st[g].on || st[g].booting || st[g].stopping));
}

/** Someone opened this machine's screen. Returns the function to call when they leave. */
export function use(machine) {
  const g = OF[machine];
  if (!g) return () => {};
  const s = st[g];
  s.users++;
  clearTimeout(s.idle);
  s.idle = null;
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    s.users = Math.max(0, s.users - 1);
    armIdle(g);
  };
}

/** Boot the VM if it is off and wait until `up()` (a VNC probe) says the
    desktop answers. Resolves true when it is ready, false on giving up. */
export async function ready(machine, up, stillWanted) {
  const g = OF[machine];
  if (!g) return true;
  const s = st[g];
  if (await up()) { s.on = true; return true; }
  if (s.stopping) await s.stopping;
  await refresh();
  if (!s.on && !s.booting) {
    s.booting = boot(g).then(() => new Promise((r) => setTimeout(r, 3000))).then(refresh).finally(() => { s.booting = null; });
  }
  if (s.booting) await s.booting;
  const until = Date.now() + BOOT_WAIT_MS;
  while (Date.now() < until) {
    if (stillWanted && !stillWanted()) return false;
    if (await up()) { s.on = true; return true; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export function vmPowerStats() {
  const out = {};
  for (const [g, s] of Object.entries(st)) out[g] = { on: s.on, users: s.users, stopping: Boolean(s.stopping), idleTimer: Boolean(s.idle) };
  return out;
}

/* At start: whatever is running with nobody on it gets the idle countdown. */
refresh().then(() => { for (const g of Object.keys(GROUPS)) armIdle(g); });
setInterval(() => { refresh().then(() => { for (const g of Object.keys(GROUPS)) { if (st[g].on && st[g].users === 0 && !st[g].idle && !st[g].stopping) armIdle(g); } }); }, 60 * 1000).unref();
