# Starts the multi-seat Linux desktop.
#
# This is the one Windows cannot do. Linux runs a separate X session per user,
# so four people get four desktops with four cursors on one machine at the same
# time - each with their own files. Windows client editions have exactly one
# session and one cursor no matter how you configure them.
#
# Seats land on host ports 5901-5904, which the proxy's bridge maps to names.
# Windows keeps 5900, so the two VMs can run side by side.
#
# First boot takes a while: cloud-init installs a desktop over the network.
# Watch it with:  powershell ... -File scripts\start-linux.ps1 -Watch
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-linux.ps1

param(
    [string]$Disk     = "D:\VMs\linux\seats.qcow2",
    [string]$Base     = "D:\VMs\linux\ubuntu-cloud.img",
    [int]   $MemoryMB = 4096,
    [int]   $Cores    = 2,
    [int]   $Seats    = 4,
    [switch]$Watch
)

$qemu = "C:\Program Files\qemu\qemu-system-x86_64.exe"
$qimg = "C:\Program Files\qemu\qemu-img.exe"
if (-not (Test-Path $qemu)) { Write-Error "QEMU not found at $qemu"; exit 1 }
if (-not (Test-Path $Base)) { Write-Error "Base image not found: $Base"; exit 1 }

# Two QEMUs writing one disk corrupts it, and this now also runs at login -
# so if the VM is already up (started by hand, say), leave it alone.
$diskName = [IO.Path]::GetFileName($Disk)
$running = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" |
    Where-Object { $_.CommandLine -like "*$diskName*" }
if ($running) { Write-Host "  already running (pid $($running.ProcessId -join ', '))"; exit 0 }

# An overlay keeps the downloaded image pristine, so starting over is a delete
# rather than another 600 MB download.
if (-not (Test-Path $Disk)) {
    Write-Host "  creating overlay on $Base"
    & $qimg create -f qcow2 -b $Base -F qcow2 $Disk 40G | Out-Null
}

# One forward per seat: host 590N -> guest 590N.
#
# Bound to 127.0.0.1, not every interface. The seats run without a VNC
# password, so an unqualified hostfwd (which listens on 0.0.0.0) handed an
# unauthenticated desktop to anyone on the same network. The Windows VM has
# always bound its own VNC to localhost; this matches it. The only way in is
# the proxy's bridge, which is where access is actually decided.
$fwd = ""
for ($i = 1; $i -le $Seats; $i++) {
    $p = 5900 + $i
    $fwd += ",hostfwd=tcp:127.0.0.1:$p-:$p"
}

# cloud-init reads its datasource out of the DMI serial number, which means no
# seed ISO to build - it fetches user-data straight from the proxy. 10.0.2.2 is
# the host as seen from QEMU's user-mode network.
$ds = "ds=nocloud-net;s=http://10.0.2.2:8080/cloudinit/"

$args = @(
    "-accel", "whpx"
    "-machine", "q35"
    # Same reasoning as the Windows VM: "max" advertises features WHPX does not
    # virtualise faithfully and the guest falls over.
    "-cpu", "Westmere"
    "-smp", "$Cores"
    "-m", "$MemoryMB"
    "-drive", "file=$Disk,if=none,id=hd0,format=qcow2,cache=writeback,discard=unmap"
    "-device", "ide-hd,drive=hd0,bus=ide.0"
    "-nic", "user,model=e1000e$fwd"
    "-smbios", "type=1,serial=$ds"
    "-vga", "std"
    "-display", "none"
    "-name", "xenon-linux"
    # Control port, so the proxy can shut it down properly when nobody has
    # used it for a while (backend/vm-power.js).
    "-qmp", "tcp:127.0.0.1:4446,server,nowait"
)

if ($Watch) {
    # A serial console is the only way to see cloud-init fail; without it a
    # broken first boot just looks like "the seats never came up".
    $args += @("-serial", "stdio")
} else {
    $args += @("-serial", "null")
}

Write-Host "  $Seats seats on host ports 5901-$((5900 + $Seats))   ram ${MemoryMB}MB   cores $Cores"
Write-Host "  first boot installs a desktop over the network - give it 5-10 minutes"

& $qemu @args
