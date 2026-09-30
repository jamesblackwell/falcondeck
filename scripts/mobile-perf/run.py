#!/usr/bin/env python3
"""Repeatable own-process CPU/physical-footprint measurements on iOS Simulator."""
import argparse
import ctypes
import hashlib
import json
import platform
import statistics
import subprocess
import time
from pathlib import Path


class Usage(ctypes.Structure):
    # Darwin sys/resource.h rusage_info_v2; CPU times are Mach clock ticks.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user', 'system', 'idle_wakes', 'interrupt_wakes', 'pageins', 'wired',
        'resident', 'footprint', 'start', 'exit', 'child_user', 'child_system',
        'child_idle_wakes', 'child_interrupt_wakes', 'child_pageins',
        'child_elapsed', 'read_bytes', 'written_bytes')]


libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
libproc.proc_pid_rusage.restype = ctypes.c_int


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


timebase = Timebase()
libsystem = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
libsystem.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
if libsystem.mach_timebase_info(ctypes.byref(timebase)) != 0 or not timebase.denom:
    raise RuntimeError('Cannot read Mach CPU timebase')
TICK_NS = timebase.numer / timebase.denom


def usage(pid):
    value = Usage()
    if libproc.proc_pid_rusage(pid, 2, ctypes.byref(value)) != 0:
        raise OSError(ctypes.get_errno(), f'Cannot sample app PID {pid}')
    return value


def command(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.PIPE)


def thread_send_refs(pid):
    # lsmp's send-only thread rows: name, object, rights, flags, reqs, send, ...
    return sum(int(line.split()[5]) for line in command('lsmp', '-p', pid).splitlines()
               if 'THREAD-CONTROL' in line and line.split()[2] == 'send')


def labels(value):
    if isinstance(value, dict):
        yield value.get('AXLabel')
        for child in value.values():
            yield from labels(child)
    elif isinstance(value, list):
        for child in value:
            yield from labels(child)


def measure(args, scenario):
    subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, 'com.falcondeck.mobile'], capture_output=True)
    pid = int(command('xcrun', 'simctl', 'launch', args.udid, 'com.falcondeck.mobile').rsplit(':', 1)[1])
    command('xcrun', 'simctl', 'openurl', args.udid, f'falcondeck://perf-qa?scenario={scenario}')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = json.loads(command('axe', 'describe-ui', '--udid', args.udid))
        visible = set(labels(state))
        if f'perf-ready-{scenario}' in visible:
            break
        if 'Open in “FalconDeck”?' in visible:
            command('axe', 'tap', '--label', 'Open', '--udid', args.udid)
        time.sleep(0.5)
    else:
        raise RuntimeError(f'Workload {scenario} did not appear; build with EXPO_PUBLIC_PERF_QA=1')
    time.sleep(args.warmup)
    refs_before = thread_send_refs(pid)
    previous, previous_at = usage(pid), time.monotonic()
    started = previous_at
    samples = []
    while time.monotonic() - started < args.seconds:
        time.sleep(0.5)
        current, now = usage(pid), time.monotonic()
        samples.append({'cpu_percent': (current.user + current.system - previous.user - previous.system) * TICK_NS / 1e9 / (now - previous_at) * 100,
                        'footprint_mb': current.footprint / 1024**2,
                        'resident_mb': current.resident / 1024**2,
                        'elapsed': now - started})
        previous, previous_at = current, now
    return {'scenario': scenario, 'pid': pid, 'thread_send_refs_before': refs_before,
            'thread_send_refs_after': thread_send_refs(pid),
            'cpu_mean': statistics.mean(s['cpu_percent'] for s in samples),
            'footprint_median_mb': statistics.median(s['footprint_mb'] for s in samples),
            'footprint_peak_mb': max(s['footprint_mb'] for s in samples), 'samples': samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--warmup', type=float, default=8)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--scenarios', default='idle,diamond,diamonds,streaming')
    args = parser.parse_args()
    if args.seconds <= 0 or args.repeats < 1 or args.warmup < 0:
        parser.error('seconds/repeats must be positive; warmup must be nonnegative')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {'label': args.label, 'udid': args.udid, 'seconds': args.seconds, 'warmup': args.warmup,
              'host': platform.platform(), 'mach_timebase': [timebase.numer, timebase.denom],
              'bundle_sha256': hashlib.sha256((args.app / 'main.jsbundle').read_bytes()).hexdigest(),
              'runs': []}
    for scenario in args.scenarios.split(','):
        for _ in range(args.repeats):
            result = measure(args, scenario)
            report['runs'].append(result)
            args.output.write_text(json.dumps(report, indent=2) + '\n')
            print(f"{args.label} {scenario}: CPU {result['cpu_mean']:.2f}%, footprint {result['footprint_median_mb']:.1f} MiB", flush=True)


if __name__ == '__main__':
    main()
