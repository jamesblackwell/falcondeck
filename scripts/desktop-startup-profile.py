#!/usr/bin/env python3
"""Read-only installed FalconDeck startup sampler (macOS; no app control).

Arm before the parent runs the documented single restart:
  python3 scripts/desktop-startup-profile.py --detach --duration 180 \
    --output /tmp/falcondeck-installed-startup.json \
    --markers /tmp/falcondeck-installed-startup.markers.jsonl
After AX confirms the overlay is gone and the sidebar is interactive:
  python3 scripts/desktop-startup-profile.py --mark-ui-ready \
    /tmp/falcondeck-installed-startup.markers.jsonl

No process arguments, paths, health response bodies, native session data, or
HTTP tokens are retained. Only same-UID exact installed no-argument main
processes and verified responsible-PID WebKit processes are measured. The
packaged daemon is embedded in the desktop PID: its CPU/RSS is not separable.
RSS sums are process sums and may double-count shared pages; phys_footprint is
also recorded. Peaks are sampled, not OS lifetime high-water marks. CPU is
kernel cumulative user+system mach ticks converted to nanoseconds (all threads, excluding children).
The private responsibility API fails closed if absent or denied. Health is
HTTP readiness only; the AX marker is a separate user-visible readiness point.
"""
import argparse
import ctypes
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request

EXE = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop'
DAEMON_EXE = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-daemon'
WEBKIT_PREFIX = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/'
WEBKIT = {
    WEBKIT_PREFIX + 'com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent': 2,
    WEBKIT_PREFIX + 'com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU': 3,
    WEBKIT_PREFIX + 'com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking': 4,
}
WEBKIT.update({os.path.realpath(path): role for path, role in list(WEBKIT.items())})
# Role codes: 1 desktop+embedded daemon, 2 UI WebContent, 3 GPU, 4 Networking,
# 5 separate installed daemon (only if verified to belong to exact main PID).
# Event codes: 1 capture armed, 2 main first observed, 3 main disappeared,
# 4 HTTP health first succeeded, 5 AX verified UI ready, 6 capture stopped.
LIB = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
LIB.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
LIB.proc_pidpath.restype = ctypes.c_int
LIB.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
LIB.proc_listpids.restype = ctypes.c_int
LIB.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
LIB.proc_pid_rusage.restype = ctypes.c_int
RESPONSIBLE = getattr(LIB, 'responsibility_get_pid_responsible_for_pid', None)
if RESPONSIBLE:
    RESPONSIBLE.argtypes = [ctypes.c_int]
    RESPONSIBLE.restype = ctypes.c_int

class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'user_ns', 'system_ns', 'idle_wakeups', 'interrupt_wakeups',
            'pageins', 'wired_bytes', 'rss_bytes', 'footprint_bytes',
            'start_absolute', 'exit_absolute')]

class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]

LIB.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
LIB.mach_absolute_time.restype = ctypes.c_uint64
TIMEBASE = Timebase()
LIB.mach_timebase_info(ctypes.byref(TIMEBASE))

def command(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              timeout=2, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ''

def path_for(pid):
    buf = ctypes.create_string_buffer(4096)
    if LIB.proc_pidpath(pid, buf, len(buf)) <= 0:
        return None
    return os.fsdecode(buf.value)

def inventory():
    # PROC_UID_ONLY=4. First filter exact executable paths cheaply, then inspect
    # transient argv for installed-desktop candidates to exclude MCP helpers.
    pid_buffer = (ctypes.c_int * 16384)()
    count = LIB.proc_listpids(4, os.getuid(), pid_buffer, ctypes.sizeof(pid_buffer))
    if count <= 0 or count >= ctypes.sizeof(pid_buffer):
        return [], []  # Fail closed if the inventory cannot be trusted.
    desktop_candidates, possible = [], []
    for pid in pid_buffer[:count // ctypes.sizeof(ctypes.c_int)]:
        if pid <= 0:
            continue
        path = path_for(pid)
        if path == EXE:
            desktop_candidates.append(pid)
        elif path in WEBKIT or path == DAEMON_EXE:
            possible.append((pid, path))
    mains = []
    if desktop_candidates:
        output = command('/bin/ps', '-ww', '-p', ','.join(map(str, desktop_candidates)),
                         '-o', 'pid=,args=')
        for line in output.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[1] == EXE:
                try:
                    pid = int(fields[0])
                except ValueError:
                    continue
                if pid in desktop_candidates and path_for(pid) == EXE:
                    mains.append(pid)
    selected = [(pid, 1, pid) for pid in mains]
    if RESPONSIBLE:
        for pid, path in possible:
            owner = RESPONSIBLE(pid)
            if owner not in mains:
                continue
            role = WEBKIT.get(path)
            if path == DAEMON_EXE:
                role = 5
            if role:
                selected.append((pid, role, owner))
    return mains, selected

def sample_process(pid, role, owner):
    usage = Usage()
    if LIB.proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
        return None
    age_ns = (LIB.mach_absolute_time() - usage.start_absolute) * TIMEBASE.numer // TIMEBASE.denom
    return {'pid': pid, 'role': role, 'owner_pid': owner,
            'start_absolute': int(usage.start_absolute),
            'age_ms': age_ns / 1e6,
            'user_cpu_ms': usage.user_ns * TIMEBASE.numer / TIMEBASE.denom / 1e6,
            'system_cpu_ms': usage.system_ns * TIMEBASE.numer / TIMEBASE.denom / 1e6,
            'cpu_ms': (usage.user_ns + usage.system_ns) * TIMEBASE.numer / TIMEBASE.denom / 1e6,
            'rss_bytes': int(usage.rss_bytes),
            'footprint_bytes': int(usage.footprint_bytes),
            'pageins': int(usage.pageins)}

class HealthProbe:
    def __init__(self):
        self.pid = None
        self.latest = {}
        self.first_success = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        cached_pid, ports = None, []
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while not self.stop.is_set():
            with self.lock:
                pid = self.pid
            if pid is not None:
                if pid != cached_pid or not ports:
                    output = command('/usr/sbin/lsof', '-nP', '-a', '-p', str(pid),
                                     '-iTCP', '-sTCP:LISTEN', '-Fn')
                    ports = []
                    for line in output.splitlines():
                        if line.startswith('n127.0.0.1:'):
                            try:
                                ports.append(int(line.rsplit(':', 1)[1]))
                            except ValueError:
                                pass
                    cached_pid = pid
                healthy = False
                for port in ports:
                    if path_for(pid) != EXE:
                        break
                    try:
                        with opener.open('http://127.0.0.1:%d/api/health' % port,
                                         timeout=0.2) as response:
                            # Never retain the body; whitelist a boolean/count.
                            body = json.loads(response.read(4097))
                            if response.status != 200 or body.get('ok') is not True:
                                continue
                            count = body.get('workspaces')
                            if not isinstance(count, int) or isinstance(count, bool):
                                continue
                            with self.lock:
                                if self.pid == pid:
                                    now = time.monotonic_ns()
                                    first = self.first_success.setdefault(pid, now)
                                    self.latest = {'pid': pid, 'ok': 1, 'workspaces': count,
                                                   'monotonic_ns': now, 'first_success_ns': first}
                            healthy = True
                            break
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
                if not healthy:
                    # Re-discover sockets: an unrelated listener may predate daemon.
                    ports = []
                    with self.lock:
                        if self.pid == pid:
                            self.latest = {}
            self.stop.wait(0.3)

    def read(self, pid):
        with self.lock:
            self.pid = pid
            return dict(self.latest) if self.latest.get('pid') == pid else {}

def write_report(path, report):
    temporary = str(path) + '.tmp'
    with open(temporary, 'w') as handle:
        json.dump(report, handle, separators=(',', ':'))
        handle.write('\n')
    os.replace(temporary, path)

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--duration', type=float, default=180)
    parser.add_argument('--interval', type=float, default=0.2)
    parser.add_argument('--output', default='/tmp/falcondeck-installed-startup.json')
    parser.add_argument('--markers', default='/tmp/falcondeck-installed-startup.markers.jsonl')
    parser.add_argument('--mark-ui-ready', metavar='JSONL_PATH')
    parser.add_argument('--detach', action='store_true',
                        help='Run once in a separate session so an app restart cannot stop capture')
    parser.add_argument('--stack-samples', action='store_true',
                        help='Capture three-second stacks for freshly launched host/UI processes')
    args = parser.parse_args()
    if args.mark_ui_ready:
        with open(args.mark_ui_ready, 'a') as handle:
            handle.write(json.dumps({'event': 5, 'monotonic_ns': time.monotonic_ns(),
                                     'utc_epoch_ns': time.time_ns()}) + '\n')
        return
    if not 0.1 <= args.interval <= 0.25 or not math.isfinite(args.duration) or not 0 < args.duration <= 3600:
        parser.error('interval must be 0.1–0.25 seconds and duration positive and at most 3600')
    if args.detach:
        with open(args.output + '.log', 'w') as log:
            child = subprocess.Popen(
                [sys.executable, os.path.realpath(__file__),
                 *(arg for arg in sys.argv[1:] if arg != '--detach')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True, close_fds=True)
        print('One-shot capture started: pid %d, log %s.log' % (child.pid, args.output))
        return
    stopping = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopping.set())
    started, utc_started = time.monotonic_ns(), time.time_ns()
    report = {'schema': 1, 'interval_ms': args.interval * 1000,
              'started_monotonic_ns': started, 'started_utc_epoch_ns': utc_started,
              'responsibility_api_available': int(RESPONSIBLE is not None),
              'embedded_daemon': 1, 'restore_phase_probe': 0,
              'events': [{'event': 1, 'elapsed_ms': 0, 'utc_epoch_ns': utc_started}],
              'samples': [], 'processes': []}
    stats, seen_mains, health_seen, marker_seen = {}, set(), set(), set()
    probe = HealthProbe()
    last_write = 0
    print('Sampler armed; numeric-only output will be written to ' + args.output, flush=True)
    while not stopping.is_set() and time.monotonic_ns() - started < args.duration * 1e9:
        cycle = time.monotonic_ns()
        elapsed = (cycle - started) / 1e6
        mains, processes = inventory()
        for pid in set(mains) - seen_mains:
            report['events'].append({'event': 2, 'pid': pid, 'elapsed_ms': elapsed,
                                     'utc_epoch_ns': time.time_ns()})
        for pid in seen_mains - set(mains):
            report['events'].append({'event': 3, 'pid': pid, 'elapsed_ms': elapsed,
                                     'utc_epoch_ns': time.time_ns()})
        seen_mains = set(mains)
        health = probe.read(mains[0] if len(mains) == 1 else None)
        if health and health['pid'] not in health_seen:
            health_seen.add(health['pid'])
            report['events'].append({'event': 4, 'pid': health['pid'],
                'elapsed_ms': (health['first_success_ns'] - started) / 1e6,
                'workspaces': health['workspaces']})
        readings = []
        for pid, role, owner in processes:
            row = sample_process(pid, role, owner)
            if row is None:
                continue
            key = (pid, row['start_absolute'])
            if key not in stats:
                stats[key] = {'pid': pid, 'role': role, 'owner_pid': owner,
                    'start_absolute': row['start_absolute'], 'first_elapsed_ms': elapsed,
                    'first_age_ms': row['age_ms'], 'initial_cpu_ms': row['cpu_ms'],
                    'peak_rss_bytes': 0, 'peak_footprint_bytes': 0, 'peak_cpu_percent': 0}
                if args.stack_samples and role in (1, 2) and row['age_ms'] < 5000:
                    subprocess.Popen(
                        ['/usr/bin/sample', str(pid), '3', '1', '-file',
                         args.output + '.%d.sample.txt' % pid],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, close_fds=True)
            stat = stats[key]
            previous = stat.get('_previous')
            sample_time = time.monotonic_ns()
            row['cpu_percent'] = max(0, 100 * (row['cpu_ms'] - previous[0]) /
                ((sample_time - previous[1]) / 1e6)) if previous else 0
            stat['_previous'] = (row['cpu_ms'], sample_time)
            stat.update(last_elapsed_ms=elapsed, last_age_ms=row['age_ms'],
                        final_cpu_ms=row['cpu_ms'], captured_cpu_ms=row['cpu_ms'] - stat['initial_cpu_ms'])
            for field in ('rss_bytes', 'footprint_bytes', 'cpu_percent'):
                stat['peak_' + field] = max(stat['peak_' + field], row[field])
            readings.append(row)
        report['samples'].append({'elapsed_ms': elapsed, 'sampling_work_ms': (time.monotonic_ns()-cycle)/1e6,
            'main_count': len(mains), 'health': health, 'processes': readings,
            'rss_sum_bytes': sum(row['rss_bytes'] for row in readings),
            'footprint_sum_bytes': sum(row['footprint_bytes'] for row in readings),
            'cpu_percent_sum': sum(row['cpu_percent'] for row in readings)})
        try:
            with open(args.markers) as handle:
                for line in handle:
                    marker = json.loads(line)
                    marker_ns = marker.get('monotonic_ns')
                    if marker.get('event') == 5 and isinstance(marker_ns, int) and marker_ns >= started and marker_ns not in marker_seen:
                        marker_seen.add(marker_ns)
                        report['events'].append({'event': 5, 'elapsed_ms': (marker_ns-started)/1e6,
                                                'utc_epoch_ns': marker.get('utc_epoch_ns', 0)})
        except (OSError, ValueError, TypeError):
            pass
        if elapsed - last_write >= 1000 or last_write == 0:
            report['processes'] = [{k:v for k,v in row.items() if not k.startswith('_')} for row in stats.values()]
            write_report(args.output, report)
            last_write = elapsed
        stopping.wait(max(0, args.interval - (time.monotonic_ns()-cycle)/1e9))
    probe.stop.set()
    report['events'].append({'event': 6, 'elapsed_ms': (time.monotonic_ns()-started)/1e6,
                             'utc_epoch_ns': time.time_ns()})
    report['processes'] = [{k:v for k,v in row.items() if not k.startswith('_')} for row in stats.values()]
    write_report(args.output, report)
    print('Sampler finished: %d samples, %d verified processes' % (len(report['samples']), len(stats)), flush=True)

if __name__ == '__main__':
    main()
