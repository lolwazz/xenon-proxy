# Restarts the Windows 10 VM when it freezes.
#
# On this machine the guest can wedge inside WHPX (2 cores, kernel-irqchip=off):
# QEMU keeps running and QMP still answers "running", but the virtual CPUs
# never wake again - the process uses exactly 0 CPU, keys do nothing, and
# even QMP system_reset does not bring it back (seen 2026-10-21: clock stuck
# at 11:59 PM for two hours). An idle Windows still burns a little CPU on
# timer ticks, so "no CPU at all for 90 seconds" means frozen. The only cure
# is a fresh QEMU, so that is what this does.
#
# Started at login by xenon-win10vm.cmd. Logs to ..\win10-watchdog.log.

param(
    [int]$IntervalSec = 30,
    [int]$StallChecks = 3,
    [double]$MinCpuSec = 0.05
)

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'win10-watchdog.log'
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content -Path $log -Encoding utf8 }

# One watchdog only.
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'win10-watchdog' -and $_.ProcessId -ne $PID }
if ($others) { exit 0 }
Log "watchdog started"

$stall = 0
$lastId = 0
$lastCpu = 0.0
while ($true) {
    Start-Sleep -Seconds $IntervalSec
    $q = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" |
        Where-Object { $_.CommandLine -match 'xenon-win10' } | Select-Object -First 1
    if (-not $q) { $stall = 0; $lastId = 0; continue }      # off on purpose, or starting
    $p = Get-Process -Id $q.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $cpu = $p.TotalProcessorTime.TotalSeconds
    if ($lastId -eq $p.Id) {
        $used = $cpu - $lastCpu
        if ($used -lt $MinCpuSec) { $stall++ } else { $stall = 0 }
        if ($stall -ge $StallChecks) {
            Log ("frozen: {0:N3}s CPU in {1}s - restarting QEMU (pid {2})" -f $used, ($IntervalSec * $StallChecks), $p.Id)
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
            Start-Process powershell -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                '-File', (Join-Path $PSScriptRoot 'start-win10.ps1'), '-MemoryMB', '6144')
            $stall = 0
            $lastId = 0
            continue
        }
    }
    $lastId = $p.Id
    $lastCpu = $cpu
}
