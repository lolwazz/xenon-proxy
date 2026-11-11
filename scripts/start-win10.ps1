# Starts the Windows 10 VM and exposes its screen on 127.0.0.1:5900 for the
# browser bridge to pick up.
#
# WHPX is the Windows Hypervisor Platform - the same hardware virtualisation
# KVM gives on Linux. Without it QEMU falls back to software emulation and
# Windows is unusable, so this refuses to start rather than pretending.
#
# The VNC server is bound to localhost only. Nothing reaches it except the
# bridge in the proxy, which is what puts it behind the site's own access.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-win10.ps1
#   powershell ... -Iso "D:\path\to\Win10.iso"      (first run, to install)

param(
    [string]$Iso     = "",
    [string]$Disk    = "D:\VMs\win10\win10.qcow2",
    [int]   $MemoryMB = 8192,
    # With 2 or more vCPUs WHPX wedged Windows *setup* (the guest pegged every
    # core and stopped writing to disk, forever), so an install from -Iso is
    # always run on one. An installed Windows gets two, which leaves the
    # host's other cores free for the proxy and the other VMs.
    [int]   $Cores    = 2,
    [int]   $VncPort  = 5900,
    # Hardening for when other people can reach it. The block below says
    # exactly what this buys and what it does not.
    [switch]$Shared
)

$qemu = "C:\Program Files\qemu\qemu-system-x86_64.exe"
if (-not (Test-Path $qemu)) { Write-Error "QEMU not found at $qemu"; exit 1 }
if (-not (Test-Path $Disk)) { Write-Error "Disk not found: $Disk"; exit 1 }

# Two QEMUs writing one disk corrupts it, and this runs at login too.
$diskName = [IO.Path]::GetFileName($Disk)
$running = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" |
    Where-Object { $_.CommandLine -like "*$diskName*" }
if ($running) { Write-Host "  already running (pid $($running.ProcessId -join ', '))"; exit 0 }

if ($Iso -ne "") { $Cores = 1 }

# QEMU counts the VNC display, not the TCP port: 5900 is display 0.
$display = $VncPort - 5900

# -------- shared mode --------
# What this actually does:
#   -snapshot     every write goes to a temporary file and is discarded when
#                 the VM stops, so nothing anyone installs survives a restart.
#   dns=1.1.1.3   Cloudflare's filtering resolver (malware + adult domains).
#   no RDP fwd    the 3389 forward is dropped so only the VNC page reaches it.
#
# What it does NOT do, and it would be a mistake to believe otherwise:
#   - It does not stop a determined person. Browsers do DNS-over-HTTPS by
#     default, which goes straight past dns= - the filter stops mattering the
#     moment someone opens Chrome.
#   - It does not know what "illegal" means. A DNS blocklist recognises some
#     categories of domain. It cannot see what someone types or does.
#   - It does not move your liability. Traffic still leaves from your home IP,
#     so anything done in here still looks like it came from you.
# 127.0.0.1, not every interface: a bare "tcp::13389" put the guest's RDP on
# the whole home network.
$nic = "user,model=e1000e,hostfwd=tcp:127.0.0.1:13389-:3389"
if ($Shared) {
    $nic = "user,model=e1000e,dns=1.1.1.3"
    Write-Host "  SHARED MODE: writes discarded on shutdown, filtered DNS, no RDP forward"
    Write-Host "  this limits accidents - it does not make the machine safe to hand out"
}

# More than one vCPU froze an installed Windows too, not just setup: the
# lock-screen clock stopped and the disk went quiet within a minute of boot.
# With several vCPUs, interrupts go through QEMU's own controller instead
# of the hypervisor's (kernel-irqchip=off).
$accel = if ($Cores -gt 1) { "whpx,kernel-irqchip=off" } else { "whpx" }

$args = @(
    "-accel", $accel
    # pc, not q35: the older chipset is far better exercised under WHPX.
    "-machine", "pc"
    # Not "max": under WHPX that advertises features the hypervisor does not
    # virtualise faithfully, and Windows setup bugchecks with
    # IRQL_NOT_LESS_OR_EQUAL as soon as it starts real work. Westmere is old
    # enough to be safe and new enough for Windows 10 x64 (SSE4.2, CMPXCHG16B,
    # LAHF/SAHF, NX all present).
    "-cpu", "Westmere"
    # One socket with N cores. Plain "-smp N" can come out as N sockets, and
    # Windows 10 Home uses a single socket - the rest would sit idle.
    "-smp", "$Cores,sockets=1,cores=$Cores,threads=1"
    "-m", "$MemoryMB"
    # SATA, not virtio: Windows setup ships no virtio storage driver, so a
    # virtio disk is simply invisible during install ("no drives found").
    # AHCI is slower but Windows has had the driver in the box since Vista.
    "-drive", "file=$Disk,if=none,id=hd0,format=qcow2,cache=writeback,discard=unmap"
    "-device", "ide-hd,drive=hd0,bus=ide.0"
    # virtio-net needs a driver Windows does not ship with, so the guest gets
    # an e1000e, which Windows 10 has in the box.
    "-nic", $nic
    # xhci makes WHPX die with "failed to unmap GPA range" on this host, so the
    # tablet hangs off the older UHCI controller instead. The tablet itself is
    # not optional: without an absolute pointer the mouse drifts under VNC.
    "-usb"
    "-device", "usb-tablet"
    "-vga", "std"
    "-vnc", "127.0.0.1:$display"
    "-rtc", "base=localtime"
    "-name", "xenon-win10"
    # A control port, local only, so the VM can be shut down cleanly
    # ({"execute":"system_powerdown"}) instead of having its plug pulled.
    "-qmp", "tcp:127.0.0.1:4444,server,nowait"
)

if ($Shared) { $args += "-snapshot" }

if ($Iso -ne "") {
    if (-not (Test-Path $Iso)) { Write-Error "ISO not found: $Iso"; exit 1 }
    $args += @("-cdrom", $Iso, "-boot", "order=d,menu=off")
    Write-Host "  booting from $Iso (install mode)"
} else {
    $args += @("-boot", "order=c,menu=off")
    Write-Host "  booting from disk"
}

Write-Host "  vnc on 127.0.0.1:$VncPort   ram ${MemoryMB}MB   cores $Cores"
Write-Host "  open the VM page on the site to see it"

& $qemu @args
