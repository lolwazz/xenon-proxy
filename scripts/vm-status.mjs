/* Says which desktops are actually usable right now.
 *
 * QEMU's port forwards accept a TCP connection whether or not anything is
 * listening inside the guest, so "the port is open" proves nothing. A real VNC
 * server greets with "RFB 003.00x" - that banner is the only honest signal,
 * and it is what this checks.
 *
 * Usage: node scripts/vm-status.mjs
 */
import net from 'node:net';
import fs from 'node:fs';

const MACHINES = [
  { name: 'Windows', id: 'win10', port: 5900, disk: 'D:/VMs/win10/win10.qcow2' },
  { name: 'Linux 1', id: 'seat1', port: 5901, disk: 'D:/VMs/linux/seats.qcow2' },
  { name: 'Linux 2', id: 'seat2', port: 5902 },
  { name: 'Linux 3', id: 'seat3', port: 5903 },
  { name: 'Linux 4', id: 'seat4', port: 5904 },
];

function banner(port, ms = 2500) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { s.destroy(); } catch {}
      res(v);
    };
    const t = setTimeout(() => end(null), ms);
    s.on('data', (d) => end(d.slice(0, 11).toString().trim()));
    s.on('error', () => end(null));
  });
}

function mb(p) {
  try { return (fs.statSync(p).size / 1048576).toFixed(0) + ' MB'; } catch { return '-'; }
}

console.log('');
for (const m of MACHINES) {
  const b = await banner(m.port);
  const state = b ? 'ready   (' + b + ')' : 'not up';
  console.log(
    '  ' + m.name.padEnd(9) + m.id.padEnd(8) + String(m.port).padEnd(6) +
    state.padEnd(22) + (m.disk ? mb(m.disk) : ''),
  );
}
console.log('');
console.log('  "not up" on the Linux seats during first boot is normal - it is');
console.log('  installing a desktop. Watch the disk figure: while it climbs, it');
console.log('  is working. When it stops climbing and the seats are still down,');
console.log('  something failed and the serial console will say what:');
console.log('    powershell -ExecutionPolicy Bypass -File scripts\\start-linux.ps1 -Watch');
