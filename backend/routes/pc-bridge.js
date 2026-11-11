/* Bridges noVNC in the browser to QEMU's VNC server.
 *
 * QEMU speaks RFB over a plain TCP socket; noVNC speaks RFB over a WebSocket.
 * The usual answer is websockify, a separate Python process. This does the
 * same job in a few lines: accept the WebSocket, open TCP to the VM, and pipe
 * the two together as binary frames. One less thing to install and one less
 * process to keep alive.
 *
 * It only ever dials 127.0.0.1 on a port from the table below - the port is
 * never taken from the request, so this cannot be pointed at anything else.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { isLocked, isOwner, isE2E, e2eSession } from '../vm-lock.js';
import { use as vmUse, ready as vmReady } from '../vm-power.js';

/* Named machines rather than caller-supplied ports: a bridge that connects
   wherever it is told is an open relay into the LAN. */
const MACHINES = {
  win10: 5900,
  /* Linux seats. Each is a separate X session on the one Linux VM, so these
     are four independent desktops with four cursors - the thing a single
     Windows VM cannot give you however it is configured. */
  seat1: 5901,
  seat2: 5902,
  seat3: 5903,
  seat4: 5904,
  android: 5905,
  /* The host PC itself, through TightVNC (installed 2026-10-23 as a
     service, loopback only, port 5910). Owner only - see vm-lock.js. */
  mypc: 5910,
};

/* One screen, one driver at a time; the others watch, and control passes by
   asking (see the rooms below). */
const SHARED = ['win10', 'android', 'mypc'];

const wss = new WebSocketServer({ noServer: true });

/* ---------------- Linux seats ----------------
 * Handed out rather than picked: a visitor asks for "a Linux desktop" and
 * gets the first seat nobody is driving. A claim holds the seat for a few
 * seconds while the viewer loads, so two people clicking at once cannot be
 * given the same one. With all four taken, they can watch a seat instead. */
const SEATS = ['seat1', 'seat2', 'seat3', 'seat4'];
const HOLD_MS = 20000;
const drivers = new Map(SEATS.map((s) => [s, new Set()]));
const watchers = new Map(SEATS.map((s) => [s, new Set()]));
const holds = new Map();      // token -> { seat, ip, until }

function pruneHolds() {
  const now = Date.now();
  for (const [t, h] of holds) { if (h.until < now) holds.delete(t); }
}
function heldBy(seat) {
  for (const [t, h] of holds) { if (h.seat === seat) return t; }
  return null;
}

export function seatState() {
  pruneHolds();
  return SEATS.map((id) => ({
    id,
    taken: drivers.get(id).size > 0 || heldBy(id) !== null,
    watching: watchers.get(id).size,
  }));
}

/* `up` is the list of seats that answered a probe; a seat whose desktop is
   not running is not offered. One open hold per address: asking again
   replaces it, so nobody can sit on all four by clicking repeatedly. */
export function claimSeat(up, ip) {
  pruneHolds();
  for (const [t, h] of holds) { if (h.ip === ip) holds.delete(t); }
  for (const seat of SEATS) {
    if (!up.includes(seat)) continue;
    if (drivers.get(seat).size > 0) continue;
    if (heldBy(seat) !== null) continue;
    const token = randomBytes(12).toString('hex');
    holds.set(token, { seat, ip, until: Date.now() + HOLD_MS });
    return { seat, token };
  }
  return null;
}

/* Client-to-server RFB, parsed so input can be let through or dropped.
 *
 * The handshake passes (with ClientInit forced to "shared", so joining never
 * disconnects anyone), and so do the messages that only ask for pictures.
 * Keys, mouse, clipboard, resizes and the xvp power commands pass only while
 * canDrive() says so - asked per chunk, because control of a shared machine
 * moves between people mid-session. Dropping them here in the bridge is the
 * enforcement; hiding them in the page alone would let anyone edit the page
 * into control.
 *
 * A message type not listed has an unknown length, so where the next message
 * starts is lost. A watcher is cut off; a driver's stream goes on unparsed,
 * and if that connection later loses control it is closed (the page
 * reconnects it as a watcher) rather than trusted. */
function rfbFilter(canDrive, onInput) {
  let pending = Buffer.alloc(0);
  let stage = 'version';
  let raw = false;
  return (chunk) => {
    const drive = canDrive();
    if (raw) return drive ? chunk : null;
    pending = Buffer.concat([pending, chunk]);
    const out = [];
    for (;;) {
      if (stage === 'version') {
        if (pending.length < 12) break;
        out.push(pending.subarray(0, 12)); pending = pending.subarray(12); stage = 'security';
        continue;
      }
      if (stage === 'security') {        // the security type the client picked (None)
        if (pending.length < 1) break;
        out.push(pending.subarray(0, 1)); pending = pending.subarray(1); stage = 'init';
        continue;
      }
      if (stage === 'init') {            // ClientInit: the shared flag
        if (pending.length < 1) break;
        out.push(Buffer.from([1])); pending = pending.subarray(1); stage = 'msgs';
        continue;
      }
      if (pending.length < 1) break;
      const type = pending[0];
      let len = 0;
      let view = false;                                          // true: pictures only, always allowed
      let known = true;
      if (type === 0) { len = 20; view = true; }                 // SetPixelFormat
      else if (type === 2) {                                     // SetEncodings
        if (pending.length < 4) break;
        len = 4 + 4 * pending.readUInt16BE(2); view = true;
      }
      else if (type === 3) { len = 10; view = true; }            // FramebufferUpdateRequest
      else if (type === 150) { len = 10; view = true; }          // EnableContinuousUpdates
      else if (type === 248) {                                   // ClientFence
        if (pending.length < 9) break;
        len = 9 + pending[8]; view = true;
      }
      else if (type === 4) { len = 8; }                          // KeyEvent
      else if (type === 5) { len = 6; }                          // PointerEvent
      else if (type === 6) {                                     // ClientCutText (negative = extended)
        if (pending.length < 8) break;
        len = 8 + Math.abs(pending.readInt32BE(4));
      }
      else if (type === 251) {                                   // SetDesktopSize
        if (pending.length < 8) break;
        len = 8 + 16 * pending[6];
      }
      else if (type === 250) { len = 4; }                        // xvp (shutdown/reboot)
      else if (type === 255) {                                   // QEMU extended key event
        if (pending.length < 2) break;
        if (pending[1] === 0) len = 12; else known = false;
      }
      else known = false;
      if (!known) {
        if (!drive) return null;
        raw = true;
        out.push(pending); pending = Buffer.alloc(0);
        break;
      }
      if (pending.length < len) break;
      if (view || drive) out.push(pending.subarray(0, len));
      if (!view && drive && onInput) onInput();
      pending = pending.subarray(len);
    }
    return Buffer.concat(out);
  };
}

/* ---------------- rooms ----------------
 * Everyone looking at a machine is in its room, over a small JSON socket
 * (/pcctl) beside the picture socket (/pcws). The room carries who is in
 * control and requests for control.
 *
 * For the shared machines the room is also where control lives: the first
 * person in drives; anyone else can ask, and the driver allows or refuses.
 * "Not really using it" counts as free - a driver who has not touched it for
 * IDLE_MS, or who lets a request time out without touching it either, hands
 * over without being asked twice. For the Linux seats control comes from the
 * seat claim instead, and the room only carries the watchers and comments.
 *
 * Every room carries comments: short lines anyone looking can post, shown
 * over the bottom-right of the screen. Held in memory only - the last few,
 * so someone arriving sees what was just said - and gone on restart. */
const IDLE_MS = 60000;
const ASK_MS = 20000;
const ROOM_MAX = 60;
const COMMENT_MAX = 200;
const COMMENT_GAP_MS = 1200;
const COMMENTS_KEPT = 30;
const rooms = new Map();         // machine -> room
const sessions = new Map();      // id -> member (for linking /pcws to its /pcctl)

function room(machine) {
  let r = rooms.get(machine);
  if (!r) {
    r = { machine, members: new Map(), controller: null, ask: null, comments: [] };
    rooms.set(machine, r);
  }
  return r;
}
function send(m, msg) {
  if (m && m.ws.readyState === m.ws.OPEN) { try { m.ws.send(JSON.stringify(msg)); } catch {} }
}
function stateOf(r) {
  const now = Date.now();
  const c = r.controller ? r.members.get(r.controller) : null;
  return {
    t: 'state',
    shared: SHARED.includes(r.machine),
    controller: c ? { name: c.name, idle: now - c.lastInput > IDLE_MS } : null,
    asking: r.ask ? (r.members.get(r.ask.from) || {}).name || null : null,
    watching: [...r.members.values()].filter((m) => m.id !== r.controller).length,
    people: [...r.members.values()].map((m) => m.name),
  };
}
function broadcast(r, msg) { for (const m of r.members.values()) send(m, msg); }
function announce(r) { broadcast(r, stateOf(r)); }

function grant(r, m, why) {
  const prev = r.controller ? r.members.get(r.controller) : null;
  if (r.ask) { clearTimeout(r.ask.timer); r.ask = null; }
  r.controller = m.id;
  m.lastInput = Date.now();
  if (prev && prev.id !== m.id) send(prev, { t: 'role', you: 'watch', why: m.name + ' has control now' });
  send(m, { t: 'role', you: 'drive', why });
  announce(r);
}
function release(r) {
  /* The one letting go is told too - otherwise their page goes on showing
     "you are in control" while the bridge drops everything they send. (When
     they left, they are already out of members and get nothing.) */
  const prev = r.controller ? r.members.get(r.controller) : null;
  r.controller = null;
  if (prev) send(prev, { t: 'role', you: 'watch', why: 'you gave up control' });
  /* Someone was waiting: they get it. Otherwise it is free for whoever
     clicks first. */
  const waiting = r.ask ? r.members.get(r.ask.from) : null;
  if (waiting) { grant(r, waiting, 'it was free'); return; }
  if (r.ask) { clearTimeout(r.ask.timer); r.ask = null; }
  announce(r);
}

function askFor(r, m) {
  const now = Date.now();
  if (r.controller === m.id) return;
  const ctl = r.controller ? r.members.get(r.controller) : null;
  if (!ctl) { grant(r, m, 'it was free'); return; }
  if (now - ctl.lastInput > IDLE_MS) { grant(r, m, ctl.name + ' was not using it'); return; }
  if (r.ask) { send(m, { t: 'answer', allowed: false, reason: 'someone else is already asking' }); return; }
  if (now - m.lastAsk < 10000) { send(m, { t: 'answer', allowed: false, reason: 'wait a few seconds before asking again' }); return; }
  m.lastAsk = now;
  r.ask = { from: m.id, at: now, timer: setTimeout(() => askTimedOut(r), ASK_MS) };
  send(ctl, { t: 'asked', from: m.name, seconds: ASK_MS / 1000 });
  announce(r);
}
function askTimedOut(r) {
  const a = r.ask;
  if (!a) return;
  r.ask = null;
  const ctl = r.controller ? r.members.get(r.controller) : null;
  const m = r.members.get(a.from);
  if (!m) { announce(r); return; }
  /* No answer. If they have not touched it since being asked, they are not
     really using it - hand it over. If they are busy in it, that is a no. */
  if (!ctl || ctl.lastInput < a.at) { grant(r, m, 'nobody answered'); return; }
  send(ctl, { t: 'asked-over' });
  send(m, { t: 'answer', allowed: false, reason: ctl.name + ' is busy and did not answer' });
  announce(r);
}
function answerAsk(r, m, allow) {
  if (r.controller !== m.id || !r.ask) return;
  const a = r.ask;
  clearTimeout(a.timer);
  r.ask = null;
  const who = r.members.get(a.from);
  if (!who) { announce(r); return; }
  if (allow) { grant(r, who, m.name + ' said yes'); return; }
  send(who, { t: 'answer', allowed: false, reason: m.name + ' said no' });
  announce(r);
}

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || 'guest';

/* Plain text only - the page draws it with textContent, never as HTML - and
   rate-limited per person so one tab cannot flood the screen. */
function postComment(r, m, raw) {
  const text = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, COMMENT_MAX);
  const now = Date.now();
  if (!text || now - m.lastComment < COMMENT_GAP_MS) return;
  m.lastComment = now;
  const c = { name: m.name, text, at: now };
  r.comments.push(c);
  if (r.comments.length > COMMENTS_KEPT) r.comments.shift();
  broadcast(r, { t: 'comment', ...c });
}

export function isControlRequest(url) {
  return /^\/pcctl(\/|$|\?)/.test(url || '');
}

export function handleControlUpgrade(req, socket, head) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  const machine = u.searchParams.get('vm') || '';
  if (!Object.prototype.hasOwnProperty.call(MACHINES, machine)) { socket.destroy(); return; }
  /* A private machine's room - who is in control, restart - is the owner's. */
  if (isLocked(machine) && !isOwner(req)) { refuse(socket); return; }
  const r = room(machine);
  if (r.members.size >= ROOM_MAX) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const m = {
      id: randomBytes(12).toString('hex'), ws, machine,
      name: cleanName(u.searchParams.get('name')),
      lastInput: 0, lastAsk: 0, lastComment: 0,
    };
    r.members.set(m.id, m);
    sessions.set(m.id, m);
    send(m, { t: 'hello', id: m.id, comments: r.comments });
    if (SHARED.includes(machine) && !r.controller) grant(r, m, 'it was free');
    else { send(m, { t: 'role', you: 'watch', why: '' }); announce(r); }

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const beat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 25000);
    /* Idle flags change on their own; keep everyone's view current. */
    const tick = setInterval(() => { if (r.controller === m.id) announce(r); }, 15000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data).slice(0, 2000)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const shared = SHARED.includes(machine);
      if (msg.t === 'name') { m.name = cleanName(msg.name); announce(r); }
      else if (msg.t === 'ask' && shared) askFor(r, m);
      else if (msg.t === 'answer' && shared) answerAsk(r, m, msg.allow === true);
      else if (msg.t === 'release' && shared) { if (r.controller === m.id) release(r); }
      else if (msg.t === 'restart') requestRestart(r, m, machine);
      else if (msg.t === 'comment') postComment(r, m, msg.text);
    });
    const leave = () => {
      clearInterval(beat);
      clearInterval(tick);
      if (!r.members.has(m.id)) return;
      r.members.delete(m.id);
      sessions.delete(m.id);
      if (r.ask && r.ask.from === m.id) { clearTimeout(r.ask.timer); r.ask = null; }
      if (r.controller === m.id) release(r); else announce(r);
      /* Their picture socket goes too, so a closed tab cannot keep driving. */
      for (const close of m.pictures || []) close();
    };
    ws.on('close', leave);
    ws.on('error', leave);
  });
}

/* Android blanks its screen when nobody has touched it for a while, and a
   blank Android just looks like a black box on the VM page. Whoever opens it
   presses the guest's wake key first, through QEMU's local control port.
   KEY_WAKEUP only ever turns the screen on - unlike the power key, which
   would turn an awake screen off. */
const QMP = { android: 4445 };
function wake(qmpPort) {
  const s = net.connect(qmpPort, '127.0.0.1');
  const w = (o) => s.write(JSON.stringify(o) + '\n');
  s.on('connect', () => {
    w({ execute: 'qmp_capabilities' });
    setTimeout(() => w({ execute: 'send-key', arguments: { keys: [{ type: 'qcode', data: 'wake' }] } }), 150);
    setTimeout(() => s.destroy(), 600);
  });
  s.on('error', () => {});
  s.setTimeout(2000, () => s.destroy());
}

/* ---------------- restart ----------------
 * A fresh QEMU, started with exactly the command line the old one had, so
 * memory, shared mode and ports all come back as they were. A guest reset
 * through QMP is not enough: when Windows wedges inside WHPX, QMP still
 * answers but system_reset does nothing (see win10-watchdog.ps1).
 *
 * Only for the shared single machines, and only for whoever is in control.
 * The Linux seats are four desktops on one VM: restarting it would throw the
 * other three people off. The new QEMU is created through WMI, so it belongs
 * to no one - not to this server, which can then restart freely. */
const RESTARTABLE = { win10: 'xenon-win10', android: 'xenon-android' };
/* VMware machines are restarted through vmrun rather than by recreating a
   process. vmrun start is launched through WMI for the same reason as QEMU. */
const VMX = { win10rtx: 'D:/VMs/win10-vmware/win10.vmx' };
const VMRUN = 'C:/Program Files (x86)/VMware/VMware Workstation/vmrun.exe';
async function restartVmware(machine) {
  const vmx = VMX[machine];
  const running = await ps(`& '${VMRUN}' -T ws list`);
  if (!running || running.toLowerCase().indexOf(vmx.toLowerCase()) < 0) return { ok: false, why: 'the machine is not running' };
  await ps(`& '${VMRUN}' -T ws stop '${vmx}' hard`);
  await new Promise((res) => setTimeout(res, 3000));
  const cmd = `"${VMRUN}" -T ws start "${vmx}" nogui`.replace(/'/g, "''");
  const made = await ps(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; CurrentDirectory = 'D:/VMs/win10-vmware' }; $r.ReturnValue`);
  return made === '0' ? { ok: true } : { ok: false, why: 'VMware would not start it again' };
}
const RESTART_GAP_MS = 120000;
const lastRestart = new Map();
function ps(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 },
      (err, out) => resolve(err ? null : String(out || '').trim()));
  });
}
async function restartQemu(machine) {
  if (VMX[machine]) return restartVmware(machine);
  const tag = RESTARTABLE[machine];
  const find = `Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-name ${tag}( |$)' } | Select-Object -First 1`;
  const info = await ps(`$q = ${find}; if ($q) { @{ pid = $q.ProcessId; cmd = $q.CommandLine; dir = (Split-Path $q.ExecutablePath) } | ConvertTo-Json -Compress }`);
  let q = null;
  try { q = info ? JSON.parse(info) : null; } catch {}
  if (!q || !q.cmd) return { ok: false, why: 'the machine is not running' };
  /* Plug pulled: an ACPI shutdown can hang for minutes on a wedged guest,
     and a restart is asked for because something is wrong. */
  await ps(`Stop-Process -Id ${Number(q.pid)} -Force -ErrorAction SilentlyContinue; $n = 0; while ((Get-Process -Id ${Number(q.pid)} -ErrorAction SilentlyContinue) -and $n -lt 40) { Start-Sleep -Milliseconds 250; $n++ }`);
  await new Promise((res) => setTimeout(res, 2000));
  const cmd = String(q.cmd).replace(/'/g, "''");
  const dir = String(q.dir || 'C:\\').replace(/'/g, "''");
  const made = await ps(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; CurrentDirectory = '${dir}' }; $r.ReturnValue`);
  return made === '0' ? { ok: true } : { ok: false, why: 'QEMU would not start again' };
}
function requestRestart(r, m, machine) {
  if (!RESTARTABLE[machine]) {
    send(m, { t: 'restart', ok: false, why: machine === 'mypc' ? 'this is the PC the site runs on - restarting it would take the site down' : 'the Linux desktops share one machine, so it can\u2019t be restarted from here' });
    return;
  }
  if (r.controller !== m.id) {
    send(m, { t: 'restart', ok: false, why: 'only the person in control can restart it' });
    return;
  }
  const since = Date.now() - (lastRestart.get(machine) || 0);
  if (since < RESTART_GAP_MS) {
    send(m, { t: 'restart', ok: false, why: 'it was just restarted - try again in ' + Math.ceil((RESTART_GAP_MS - since) / 1000) + 's' });
    return;
  }
  lastRestart.set(machine, Date.now());
  broadcast(r, { t: 'restart', ok: true, by: m.name, stage: 'stopping' });
  restartQemu(machine).then((res) => {
    if (!res.ok) lastRestart.delete(machine);
    broadcast(r, res.ok ? { t: 'restart', ok: true, stage: 'booting' } : { t: 'restart', ok: false, why: res.why });
  });
}

function refuse(socket) {
  try { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); }
}

export function isBridgeRequest(url) {
  return /^\/pcws(\/|$|\?)/.test(url || '');
}

export function handleBridgeUpgrade(req, socket, head) {
  let name = 'win10';
  let u = null;
  try {
    u = new URL(req.url, 'http://localhost');
    const asked = u.searchParams.get('vm');
    if (asked && Object.prototype.hasOwnProperty.call(MACHINES, asked)) name = asked;
  } catch {
    /* default machine */
  }
  /* Its screen and keyboard too. Checked after the name is settled: an
     unknown or missing vm= falls back to win10, so it must be checked here. */
  if (isLocked(name) && !isOwner(req)) { refuse(socket); return; }
  const port = MACHINES[name];
  if (QMP[name]) wake(QMP[name]);

  /* A seat is driven by the holder of its claim. Without one - an older
     copy of the page, a pasted link - a free seat is driven and a taken
     one is watched: never steal a seat from someone using it. */
  let role = 'drive';
  if (SEATS.includes(name)) {
    pruneHolds();
    const claim = (u && u.searchParams.get('claim')) || '';
    const hold = claim ? holds.get(claim) : null;
    if (u && u.searchParams.get('watch') === '1') role = 'watch';
    else if (hold && hold.seat === name) holds.delete(claim);
    else if (drivers.get(name).size > 0 || heldBy(name) !== null) role = 'watch';
  }

  /* A shared machine is driven by whoever its room says has control, asked
     afresh for every chunk. The picture socket names its room session (sid);
     without one - an old copy of the page - it can only watch. */
  const member = SHARED.includes(name) ? sessions.get((u && u.searchParams.get('sid')) || '') : null;
  const shared = SHARED.includes(name);
  let canDrive;
  if (shared) {
    canDrive = () => Boolean(member && member.machine === name && sessions.has(member.id) &&
      room(name).controller === member.id);
  } else {
    canDrive = () => role === 'drive';
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    /* The owner's PC is end-to-end encrypted (see vm-lock.js): its VNC
       server is not even dialled until the browser has proven it holds the
       key, and from then on every frame both ways is sealed. */
    const sec = isE2E(name) ? e2eSession() : null;
    let tcp = null;
    let handshakeTimer = null;
    let open = true;
    /* Seat drivers and everything else unshared are piped straight through;
       watchers and every shared-machine connection go through the filter. */
    const filter = (shared || role === 'watch')
      ? rfbFilter(canDrive, member ? () => { member.lastInput = Date.now(); } : null)
      : null;
    const roster = SEATS.includes(name) ? (role === 'watch' ? watchers : drivers).get(name) : null;
    if (roster) roster.add(ws);
    /* VMs sleep while nobody is on them (backend/vm-power.js). */
    const release = vmUse(name);
    if (member) { member.pictures = member.pictures || []; member.pictures.push(() => shut('left the room')); }

    /* A tab that vanishes without closing (sleep, lost Wi-Fi) would hold its
       seat forever; a missed ping frees it within a minute. */
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const beat = setInterval(() => {
      if (!alive) { shut('no heartbeat'); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 25000);

    const shut = (why) => {
      if (!open) return;
      open = false;
      clearInterval(beat);
      clearTimeout(handshakeTimer);
      if (roster) roster.delete(ws);
      release();
      try { if (tcp) tcp.destroy(); } catch {}
      try { ws.close(sec ? 4001 : 1000, why); } catch {}
    };

    function pipe() {
      tcp = net.connect({ host: '127.0.0.1', port });
      tcp.on('connect', () => {
        /* Nagle would batch the small RFB messages that carry input, which is
           exactly the traffic that must not wait. */
        tcp.setNoDelay(true);
      });
      tcp.on('data', (buf) => {
        if (ws.readyState === ws.OPEN) ws.send(sec ? sec.seal(buf) : buf, { binary: true });
      });
      /* A VM that is not running is the normal case, not an error worth
         crashing over - the page shows it as "not running". */
      tcp.on('error', () => shut('vm unreachable'));
      tcp.on('close', () => shut('vm closed'));
    }

    ws.on('message', (data, isBinary) => {
      if (sec && !tcp) {
        /* The browser's answer to the handshake. Anything else first is
           someone without the key. */
        let msg = null;
        if (!isBinary) { try { msg = JSON.parse(String(data)); } catch {} }
        const ok = sec.accept(msg);
        if (!ok) {
          try { ws.send(JSON.stringify({ t: 'e2e-fail' })); } catch {}
          shut('key proof failed');
          return;
        }
        clearTimeout(handshakeTimer);
        ws.send(JSON.stringify(ok));
        pipe();
        return;
      }
      if (!tcp || !tcp.writable) return;
      let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (sec) {
        buf = isBinary ? sec.open(buf) : null;
        if (!buf) { shut('frame failed its check'); return; }
      }
      if (!filter) { tcp.write(buf); return; }
      const pass = filter(buf);
      if (pass === null) { shut('watchers cannot send that'); return; }
      if (pass.length) tcp.write(pass);
    });

    /* A sleeping VM boots now; the screen connects once its desktop answers. */
    if (!sec) vmReady(name, () => probe(name), () => open).then((ok) => { if (!open) return; if (ok) pipe(); else shut('vm did not start'); });
    else if (!sec.ready()) shut('the server key is not ready yet');
    else {
      ws.send(JSON.stringify(sec.hello()));
      handshakeTimer = setTimeout(() => shut('handshake timed out'), 15000);
    }
    ws.on('close', () => shut('client left'));
    ws.on('error', () => shut('client error'));
  });
}

/* Used by the page to decide what to show before opening a socket. */
/* A connection that opens is not a desktop that answers.
 *
 * The Windows VM's VNC server is QEMU itself, so connecting to 5900 means it
 * is really there. The Linux seats are different: they live inside the guest
 * and reach the host through QEMU's hostfwd, which accepts the TCP connection
 * whether or not anything is listening on the other side. Probing by connect
 * alone therefore reported all four seats "running" from the moment the VM
 * started - the page lit them green and connecting then failed.
 *
 * So wait for the greeting. Every VNC server opens with "RFB 003.00x\n"
 * before the client says anything.
 *
 * For the seats, reading the greeting is not enough either. TigerVNC
 * black-lists an address after five connections that close without
 * authenticating, and to the guest every connection - this probe's and every
 * visitor's - comes from the same QEMU gateway address. A probe that hung up
 * after the greeting counted as a failed login, so a few page loads locked
 * all four seats for everyone ("Too many security failures", 10 s, then 20,
 * 40...). The probe therefore finishes the no-password handshake: a
 * successful authentication clears the mark instead of adding one. It stops
 * before ClientInit, so no session starts and nobody connected is touched.
 * A black-listed seat greets with 003.003 and a refusal, and reads as down. */
export function probe(name) {
  const port = MACHINES[name] || MACHINES.win10;
  const login = SEATS.includes(name);      // QEMU's own server (win10, android) does not black-list
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    let buf = Buffer.alloc(0);
    let stage = 'greeting';
    const done = (up) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch {}
      resolve(up);
    };
    s.setTimeout(2500);
    s.on('data', (b) => {
      buf = Buffer.concat([buf, b]);
      if (stage === 'greeting') {
        if (buf.length < 12) return;
        const greet = buf.toString('latin1', 0, 12);
        if (!greet.startsWith('RFB')) return done(false);
        if (!login) return done(true);
        if (greet !== 'RFB 003.008\n') return done(false);
        s.write('RFB 003.008\n');
        buf = buf.subarray(12);
        stage = 'types';
      }
      if (stage === 'types') {
        if (buf.length < 1) return;
        const n = buf[0];
        if (n === 0) return done(false);          // refused; a reason follows
        if (buf.length < 1 + n) return;
        /* A seat that has been given a password cannot be logged into from
           here; the greeting is then all there is to check. */
        if (!buf.subarray(1, 1 + n).includes(1)) return done(true);
        s.write(Buffer.from([1]));                // security type None
        buf = buf.subarray(1 + n);
        stage = 'result';
      }
      if (stage === 'result') {
        if (buf.length < 4) return;
        done(buf.readUInt32BE(0) === 0);
      }
    });
    s.on('timeout', () => done(false));   // connected, but nothing is serving
    s.on('error', () => done(false));
    s.on('close', () => done(false));
  });
}
