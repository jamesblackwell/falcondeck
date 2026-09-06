"""Bounded discovery matrix. Failed attempts stay visible even when a retry passes."""
import argparse
import json
from pathlib import Path
import time
import uuid
import lab
import scenarios

PROTOCOL = [
    ('healthy', 0), ('constrained', 0), ('severe', 0), ('packet-loss', 0),
    ('concurrent-reads', 0), ('urgent-during-sync', 0), ('downstream-blackhole', 3),
    ('upstream-blackhole', 3), ('daemon-blackhole', 3),
    ('send-reply-loss', 0), ('restart-daemon', 0), ('bulk', 0),
]
MOBILE = [('ui-send', 0), ('ui-send-reply-loss', 3), ('draft-relaunch', 0),
          ('model-picker', 0), ('mobile-blackhole', 55), ('background', 90)]


def seeds(value):
    values = [int(item) for item in value.split(',')]
    if not 1 <= len(values) <= 5 or len(set(values)) != len(values):
        raise argparse.ArgumentTypeError('Provide 1–5 distinct comma-separated integer seeds')
    return values


def exercise(case, retry_count, run=scenarios.run):
    result = {'case': vars(case), 'attempts': []}
    for _ in range(retry_count + 1):
        try:
            path = run(case)
            result['attempts'].append({'passed': True, 'report': str(path)})
            break
        except scenarios.ScenarioFailure as error:
            result['attempts'].append({'passed': False, 'report': str(error.report_path), 'error': str(error)})
    outcomes = [attempt['passed'] for attempt in result['attempts']]
    result['status'] = 'passed' if all(outcomes) else 'intermittent' if any(outcomes) else 'failed'
    return result


def write(directory, report):
    temporary = directory/'campaign.tmp'
    temporary.write_text(json.dumps(report, indent=2))
    temporary.replace(directory/'campaign.json')
    rows = ['# Bug discovery campaign', '', f"Status: {report['status']}", '',
            '| Scenario | Seed | Result | Attempts |', '| --- | --- | --- | --- |']
    for result in report['results']:
        links = ', '.join(f"[{i+1}: {'pass' if a['passed'] else 'fail'}]({Path(a['report']).relative_to(lab.ROOT).as_posix()})"
                          for i,a in enumerate(result['attempts']))
        # Reports live two levels below ROOT; keep links portable with the evidence folder.
        links = links.replace('](runs/', '](../../runs/')
        rows.append(f"| {result['case']['scenario']} | {result['case']['seed']} | {result['status']} | {links} |")
    rows += ['', 'A retry never erases a failure. Repeated failures require root-cause triage; they are not automatically product bugs.',
             'Seeds reproduce the fault schedule, not OS scheduling. These are bounded samples, not a certification.', '']
    (directory/'summary.md').write_text('\n'.join(rows))


def run(args):
    state = lab.load()
    # Refuse to confuse an unavailable lab with a matrix of product defects.
    lab.http(state['daemon_url']+'/api/health')
    lab.http(state['phone_url']+'/health')
    if args.suite != 'protocol' and not state.get('simulator'):
        raise RuntimeError('Install and pair the simulator before a mobile campaign')
    cases = PROTOCOL if args.suite == 'protocol' else MOBILE if args.suite == 'mobile' else PROTOCOL + MOBILE
    directory = lab.ROOT/'campaigns'/(time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    directory.mkdir(parents=True)
    report = {'status': 'running', 'suite': args.suite, 'seeds': args.seeds,
              'fixture': state['fixture'], 'results': []}
    write(directory, report)
    print(f'Campaign: {directory}/summary.md', flush=True)
    try:
        for seed in args.seeds:
            for name, outage in cases:
                print(f'Discover: {name} seed={seed}', flush=True)
                case = argparse.Namespace(scenario=name, seed=seed, cycles=3, outage=outage)
                report['results'].append(exercise(case, args.retries))
                write(directory, report)
        report['status'] = 'passed' if all(r['status']=='passed' for r in report['results']) else 'failures-found'
    except BaseException as error:
        report['status'] = 'interrupted'
        report['error'] = str(error)
        raise
    finally:
        write(directory, report)
        print(f'Campaign: {directory}/summary.md ({report["status"]})', flush=True)
    if report['status'] != 'passed':
        raise SystemExit(1)
