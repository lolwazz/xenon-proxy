# Starts the Android VM (Android-x86 9.0) for the VM page.
#
# One screen, shared like Windows 10: one person drives, the rest watch and
# can ask for control. VNC on host port 5905, which the proxy's bridge maps
# to the name "android".
#
# First time: install Android to the disk from the ISO with -Install. After
# that it boots from the disk.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-android.ps1 [-Install]

param(
    [string]$Disk     = "D:\VMs\android\android.qcow2",
    [string]$Iso      = "D:\VMs\android\android-x86_64-9.0-r2.iso",
    # 2 GB, not 3: it shares the host with Windows 10 and the Linux seats,
    # and Android 9 runs fine on two.
    [int]   $MemoryMB = 2048,
    # A Linux kernel copes with several vCPUs under WHPX (the Linux seats run
    # on two); it was Windows that froze.
    [int]   $Cores    = 2,
    [int]   $VncPort  = 5905,
    [switch]$Install
)

$qemu = "C:\Program Files\qemu\qemu-system-x86_64.exe"
$qimg = "C:\Program Files\qemu\qemu-img.exe"
if (-not (Test-Path $qemu)) { Write-Error "QEMU not found at $qemu"; exit 1 }

# Two QEMUs writing one disk corrupts it, and this runs at login too.
$diskName = [IO.Path]::GetFileName($Disk)
$running = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" |
    Where-Object { $_.CommandLine -like "*$diskName*" }
if ($running) { Write-Host "  already running (pid $($running.ProcessId -join ', '))"; exit 0 }

if (-not (Test-Path $Disk)) {
    if (-not $Install) { Write-Error "No Android disk yet - run with -Install first"; exit 1 }
    Write-Host "  creating $Disk"
    & $qimg create -f qcow2 $Disk 16G | Out-Null
}

$display = $VncPort - 5900

$args = @(
    "-accel", "whpx"
    "-machine", "pc"
    # Android 9 x86_64 needs SSE4.2 and POPCNT, which Westmere has; "max"
    # misbehaves under WHPX (see the Windows script).
    "-cpu", "Westmere"
    "-smp", "$Cores"
    "-m", "$MemoryMB"
    "-drive", "file=$Disk,if=none,id=hd0,format=qcow2,cache=writeback,discard=unmap"
    "-device", "ide-hd,drive=hd0,bus=ide.0"
    # e1000: in the Android-x86 kernel, no extra driver needed. Local-only and
    # outbound only - nothing is forwarded into the guest.
    "-nic", "user,model=e1000"
    # An absolute pointer, so clicks land where the cursor is under VNC; the
    # guest treats it as a touch-style pointer.
    "-usb"
    "-device", "usb-tablet"
    "-vga", "std"
    "-vnc", "127.0.0.1:$display"
    "-name", "xenon-android"
    # Local control port, for a clean shutdown ({"execute":"system_powerdown"}).
    "-qmp", "tcp:127.0.0.1:4445,server,nowait"
)

if ($Install) {
    if (-not (Test-Path $Iso)) { Write-Error "ISO not found: $Iso"; exit 1 }
    $args += @("-cdrom", $Iso, "-boot", "order=d,menu=off")
    Write-Host "  booting the installer from $Iso"
} else {
    $args += @("-boot", "order=c,menu=off")
}

Write-Host "  vnc on 127.0.0.1:$VncPort   ram ${MemoryMB}MB   cores $Cores"
& $qemu @args
