#!/usr/bin/env python3
"""Isolated FalconDeck reliability lab. State and credentials stay under ignored var/."""
import argparse
import fcntl
import tempfile
import hashlib
import json
import os
from pathlib import Path
import random
import plistlib
import secrets
import signal
import shlex
import socket
import subprocess
import sys
import time
import urllib.request

REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / 'var/reliability'
STATE = ROOT / 'lab.json'
BUNDLE = 'com.falcondeck.mobile'
PROFILES = json.loads((Path(__file__).parent / 'profiles.json').read_text())


def command(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, cwd=REPO, text=True, **kwargs)


def output(args):
    return command(args, capture_output=True).stdout.strip()


def http(url, body=None, method=None, timeout=10):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                    headers={'Content-Type': 'application/json'}, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        return json.loads(data) if data else None


def wait(predicate, timeout=60, description='condition'):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            last = error
        time.sleep(.25)
    raise TimeoutError(f'Timed out waiting for {description}: {last}')


def load():
    return json.loads(STATE.read_text())


def save(state):
    ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',dir=ROOT,delete=False) as temporary:
        json.dump(state,temporary,indent=2)
    Path(temporary.name).replace(STATE)
    STATE.chmod(0o600)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def compose(state, *args):
    env = {**os.environ, **{key: str(value) for key, value in state['env'].items()}}
    return command(['docker', 'compose', '-p', state['owner'], '-f', 'scripts/reliability/compose.yml', *args], env=env)


def start_process(state, name, args, env):
    path = ROOT / f'{name}.log'
    with path.open('a') as log:
        process = subprocess.Popen([str(x) for x in args], cwd=REPO, env={**os.environ, **env},
                                   stdout=log, stderr=log, start_new_session=True)
    state['processes'][name] = {'pid': process.pid, 'args': [str(x) for x in args],
        'sha256': hashlib.sha256(Path(args[0]).read_bytes()).hexdigest()}
    save(state)
    time.sleep(.1)
    if process.poll() is not None:
        raise RuntimeError(f'{name} exited during startup; see {path}')


def stop_process(state, name):
    record = state['processes'].get(name)
    if not record:
        return
    # Check command identity before signalling a persisted PID that might have been reused.
    found = subprocess.run(['ps', '-p', str(record['pid']), '-o', 'command='], capture_output=True, text=True)
    if found.returncode == 0 and shlex.split(found.stdout.strip())[:len(record['args'])] == record['args']:
        os.killpg(record['pid'], signal.SIGTERM)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            current=subprocess.run(['ps','-p',str(record['pid']),'-o','command='],capture_output=True,text=True)
            if current.returncode!=0 or shlex.split(current.stdout.strip())[:len(record['args'])]!=record['args']:
                break
            time.sleep(.1)
        else:
            os.killpg(record['pid'],signal.SIGKILL)
    state['processes'].pop(name, None)
    save(state)


def proxy_api(state):
    return f"http://127.0.0.1:{state['env']['LAB_PROXY_API']}"


def profile(state, name, link='phone'):
    base = f'{proxy_api(state)}/proxies/{link}'
    for toxic in http(base)['toxics']:
        http(f"{base}/toxics/{toxic['name']}", method='DELETE')
    http(base, {'enabled': True})
    if name == 'reset':
        http(base, {'enabled': False})
        http(base, {'enabled': True})
    else:
        for index, toxic in enumerate(PROFILES[name]):
            http(f'{base}/toxics', {**toxic, 'name': f'lab-{index}', 'toxicity': 1})


def netem(state, loss=0, delay=0, seed=1, link='phone'):
    # Only the proxy -> test-client flow is shaped; the control API stays reachable.
    compose(state, 'exec', '-T', 'netem', 'sh', '-c', 'tc qdisc del dev eth0 root 2>/dev/null || true')
    if not loss and not delay:
        return
    compose(state, 'exec', '-T', 'netem', 'tc','qdisc','add','dev','eth0','root','handle','1:',
            'prio','bands','3','priomap', *(['0']*16))
    compose(state, 'exec', '-T', 'netem', 'tc','qdisc','add','dev','eth0','parent','1:3','handle','30:',
            'netem','delay',f'{delay}ms','loss',f'{loss}%','seed',str(seed))
    compose(state, 'exec', '-T', 'netem', 'tc','filter','add','dev','eth0','protocol','ip','parent','1:',
            'prio','1','u32','match','ip','sport','8666' if link=='phone' else '8667','0xffff','flowid','1:3')


def up(args):
    ROOT.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    if STATE.exists():
        raise RuntimeError('Lab already exists; use reliability-down before creating another lab')
    if not 1 <= args.workspaces <= 40 or not 1 <= args.threads <= 2000 or args.workspaces*args.threads > 2000 or not 0 <= args.lines <= 10000 or not 0 <= args.bulk_bytes <= 20*1024*1024 or not 60 <= args.ttl <= 86400:
        raise ValueError('Fixture bounds: 1–2000 threads, 0–10000 lines, 0–20MiB bulk; TTL 60–86400 seconds')
    state = {'owner': 'fdlab-' + secrets.token_hex(4), 'processes': {}, 'env': {},
             'created_at': time.time(), 'commit': output(['git', 'rev-parse', 'HEAD'])}
    for key in ['LAB_DB_PORT', 'LAB_PROXY_API', 'LAB_PHONE_PORT', 'LAB_DAEMON_PROXY_PORT']:
        state['env'][key] = free_port()
    state['env']['LAB_DB_PASSWORD'] = secrets.token_hex(16)
    state['relay_port'], state['daemon_port'] = free_port(), free_port()
    state['daemon_url'] = f"http://127.0.0.1:{state['daemon_port']}"
    state['phone_url'] = f"http://127.0.0.1:{state['env']['LAB_PHONE_PORT']}"
    state['daemon_proxy_url'] = f"http://127.0.0.1:{state['env']['LAB_DAEMON_PROXY_PORT']}"
    state['data_root'] = str(ROOT/state['owner'])
    Path(state['data_root']).mkdir()
    save(state)
    try:
        command(['cargo', 'build', '-q', '-p', 'falcondeck-daemon', '-p', 'falcondeck-relay'])
        compose(state, 'up', '-d', '--wait')
        start_process(state, 'relay', [REPO/'target/debug/falcondeck-relay'], {
            'FALCONDECK_RELAY_BIND': f"0.0.0.0:{state['relay_port']}",
            'FALCONDECK_RELAY_DATABASE_URL': f"postgres://lab:{state['env']['LAB_DB_PASSWORD']}@127.0.0.1:{state['env']['LAB_DB_PORT']}/lab",
            'RUST_LOG': 'falcondeck_relay=debug'})
        wait(lambda: http(f"http://127.0.0.1:{state['relay_port']}/health"), description='relay health')
        wait(lambda: http(proxy_api(state)+'/version'), description='proxy API')
        for name, port in [('phone',8666),('daemon',8667)]:
            http(proxy_api(state)+'/proxies', {'name': name, 'listen': f'0.0.0.0:{port}',
                 'upstream': f"host.docker.internal:{state['relay_port']}", 'enabled': True})
        from seed import write_fixture
        workspaces = write_fixture(Path(state['data_root']),args.threads,args.lines,args.bulk_bytes,args.workspaces)
        for workspace in workspaces:
            command(['git','init','-q',workspace])
        state['fixture'] = {'threads':args.threads,'lines':args.lines,'bulk_bytes':args.bulk_bytes,'workspaces':args.workspaces}
        state['daemon_env'] = {'FALCONDECK_STATE_PATH': str(Path(state['data_root'])/'daemon/state.json'),
            'FALCONDECK_SECRET_FILE': str(Path(state['data_root'])/'daemon/secrets.json'),
            'FALCONDECK_LAB_ROOT':state['data_root'], 'RUST_LOG':'falcondeck_daemon=debug'}
        start_process(state, 'daemon', [REPO/'target/debug/falcondeck-daemon',
                      f"--port={state['daemon_port']}", f'--codex-bin={REPO}/scripts/reliability/fixture-codex.mjs',
                      '--claude-bin=/usr/bin/false'], state['daemon_env'])
        wait(lambda: http(state['daemon_url']+'/api/health'), description='daemon health')
        for workspace in workspaces:
            http(state['daemon_url']+'/api/workspaces/connect', {'path':str(workspace)}, timeout=120)
        start_process(state, 'expiry', [sys.executable, REPO/'scripts/reliability/expire.py', state['owner'], str(args.ttl)], {})
        save(state)
        print('Lab ready. Pair through the simulator or run the protocol smoke suite.')
    except BaseException:
        down(None)
        raise


def pairing(state):
    result = http(state['daemon_url']+'/api/remote/pairing', {'relay_url':state['daemon_proxy_url']}, timeout=30)
    return result['pairing']['pairing_code']


def down(_):
    if not STATE.exists():
        return
    state = load()
    for name in list(state['processes']):
        stop_process(state, name)
    compose(state, 'down', '--volumes', '--remove-orphans')
    if state.get('simulator'):
        command(['xcrun','simctl','shutdown',state['simulator']])
        command(['xcrun','simctl','delete',state['simulator']])
    STATE.rename(ROOT / f"{state['owner']}-closed.json")


def bounded_tail(path, limit):
    with path.open('rb') as file:
        file.seek(0,2)
        start=max(0,file.tell()-limit)
        file.seek(start)
        if start: file.readline()
        return file.read(limit)


def capture(state, directory, label):
    directory.mkdir(parents=True, exist_ok=True)
    if state.get('simulator'):
        for suffix, args in [('json',['axe','describe-ui','--udid',state['simulator']]),
                             ('png',['axe','screenshot','--udid',state['simulator'],'--output',directory/f'{label}.png'])]:
            try:
                result = subprocess.run([str(x) for x in args], cwd=REPO, capture_output=True, text=True, timeout=20)
            except subprocess.TimeoutExpired:
                (directory/f'{label}-{suffix}-capture-error.txt').write_text('Simulator capture timed out')
                continue
            if suffix == 'json':
                (directory/f'{label}.json').write_text(result.stdout + result.stderr)
    trace = Path(state['data_root'])/'mobile-trace.jsonl'
    if trace.exists():
        (directory/'mobile-trace.jsonl').write_bytes(bounded_tail(trace,4_000_000))
    for name in ['daemon','relay']:
        path = ROOT/f'{name}.log'
        if path.exists():
            (directory/f'{name}.log').write_bytes(bounded_tail(path,2_000_000))


def simulator(args):
    state = load()
    if not state.get('simulator'):
        state['simulator'] = output(['xcrun','simctl','create',state['owner'],
            'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',args.runtime])
        save(state)
    device = state['simulator']
    if 'collector' not in state['processes']:
        state['trace_port'] = free_port()
        start_process(state, 'collector', [sys.executable, REPO/'scripts/reliability/collector.py', str(state['trace_port']), state['data_root']], {})
    subprocess.run(['xcrun','simctl','boot',device], capture_output=True)
    command(['xcrun','simctl','bootstatus',device,'-b'])
    app = ROOT/'DerivedData/Build/Products/Release-iphonesimulator/FalconDeck.app'
    if not args.skip_build:
        with (ROOT/'build.log').open('w') as log:
            command(['xcodebuild','-workspace','apps/mobile/ios/FalconDeck.xcworkspace','-scheme','FalconDeck',
                '-configuration','Release','-sdk','iphonesimulator','-destination',f'id={device}',
                '-derivedDataPath',ROOT/'DerivedData','CODE_SIGNING_ALLOWED=YES','CODE_SIGN_IDENTITY=-','CODE_SIGNING_REQUIRED=NO'], stdout=log, stderr=log,
                env={**os.environ, 'EXPO_PUBLIC_RELIABILITY_URL': f"http://127.0.0.1:{state['trace_port']}"})
    # Only modify the disposable build product: prevent production OTA replacing the test bundle.
    command(['/usr/libexec/PlistBuddy','-c','Set :EXUpdatesEnabled false',app/'Expo.plist'])
    command(['codesign','--force','--sign','-','--preserve-metadata=entitlements',app])
    command(['xcrun','simctl','install',device,app])
    launch = output(['xcrun','simctl','launch',device,BUNDLE])
    state['app_pid'] = int(launch.rsplit(':',1)[1].strip())
    state['app_sha256'] = hashlib.sha256((app/'main.jsbundle').read_bytes()).hexdigest()
    save(state)
    print('Simulator installed. Run pair-ui to complete the normal pairing flow.')


def ui(state):
    return json.loads(output(['axe','describe-ui','--udid',state['simulator']]))


def tap(state, label):
    command(['axe','tap','--label',label,'--udid',state['simulator']])


def nodes(tree):
    for node in tree:
        yield node
        yield from nodes(node.get('children', []))


def fill(state, label, value):
    if label=='Message':
        command(['axe','tap','--id','message-composer','--post-delay','0.5','--udid',state['simulator']])
    else:
        # Focus arrives asynchronously on a fresh simulator. Cmd+A sent in
        # the tap's turn can be ignored, causing paste to append to the URL.
        command(['axe','tap','--label',label,'--post-delay','0.5','--udid',state['simulator']])
    command(['xcrun','simctl','pbcopy',state['simulator']],input=value)
    command(['axe','key-combo','--key','4','--modifiers','227','--udid',state['simulator']])
    command(['axe','key-combo','--key','25','--modifiers','227','--udid',state['simulator']])
    wait(lambda:any(n.get('AXValue')==value for n in nodes(ui(state))),
         timeout=5,description=f'field {label}')


def pair_ui(_):
    state = load()
    wait(lambda:'Self-hosted relay settings' in json.dumps(ui(state)), description='pairing screen')
    if not any(n.get('AXLabel')=='Relay URL' for n in nodes(ui(state))):
        tap(state,'Self-hosted relay settings')
    fill(state,'Relay URL',state['phone_url'])
    tap(state,'Self-hosted relay settings')
    fill(state,'Secure pairing code',pairing(state))
    tap(state,'Connect')
    wait(lambda: http(f"http://127.0.0.1:{state['trace_port']}").get('relay.state',{}).get('synced'),
         timeout=90,description='synced mobile state')
    capture(state, ROOT/'pairing-evidence','paired')


def refresh(_):
    state=load()
    command(['cargo','build','-q','-p','falcondeck-daemon','-p','falcondeck-relay'])
    daemon_args=state['processes']['daemon']['args']
    relay_args=state['processes']['relay']['args']
    for name in ['daemon','relay']:
        pid=state['processes'][name]['pid']
        stop_process(state,name)
        wait(lambda:subprocess.run(['kill','-0',str(pid)],capture_output=True).returncode!=0,
             timeout=15,description=f'{name} exit')
    start_process(state,'relay',relay_args,{
        'FALCONDECK_RELAY_BIND':f"0.0.0.0:{state['relay_port']}",
        'FALCONDECK_RELAY_DATABASE_URL':f"postgres://lab:{state['env']['LAB_DB_PASSWORD']}@127.0.0.1:{state['env']['LAB_DB_PORT']}/lab",
        'RUST_LOG':'falcondeck_relay=debug'})
    wait(lambda:http(state['phone_url']+'/health'),description='relay restart')
    start_process(state,'daemon',daemon_args,state['daemon_env'])
    wait(lambda:http(state['daemon_url']+'/api/health'),description='daemon restart')
    if 'expiry' not in state['processes']:
        start_process(state,'expiry',[sys.executable,REPO/'scripts/reliability/expire.py',state['owner'],'14400'],{})


def reseed(args):
    from seed import write_fixture
    state=load()
    if not 0 <= args.bulk_bytes <= 20*1024*1024:
        raise ValueError('Bulk fixture must be between 0 and 20 MiB')
    record=state['processes']['daemon']
    stop_process(state,'daemon')
    wait(lambda:subprocess.run(['kill','-0',str(record['pid'])],capture_output=True).returncode!=0,
         timeout=15,description='test daemon exit')
    fixture=state['fixture']
    fixture['bulk_bytes']=args.bulk_bytes
    write_fixture(Path(state['data_root']),fixture['threads'],fixture['lines'],args.bulk_bytes,fixture.get('workspaces',1))
    start_process(state,'daemon',record['args'],state['daemon_env'])
    wait(lambda:http(state['daemon_url']+'/api/health'),description='test daemon restart')


def suite(scenarios, cycles=5, seed=1):
    import scenarios as runner
    for name in scenarios:
        runner.run(argparse.Namespace(scenario=name,seed=seed,cycles=cycles,outage=5))


def replay(args):
    import scenarios
    report = json.loads(args.report.read_text())
    state=load()
    if state['fixture']!=report['fixture']:
        raise RuntimeError('Restore the recorded fixture settings before replay')
    scenarios.run(argparse.Namespace(scenario=report['scenario'],seed=report['seed'],
                  cycles=report['cycles'],outage=report['outage'],compact_index=report.get('compact_index',False)))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('up'); p.add_argument('--threads',type=int,default=30); p.add_argument('--workspaces',type=int,default=1); p.add_argument('--lines',type=int,default=100); p.add_argument('--bulk-bytes',type=int,default=5242880); p.add_argument('--ttl',type=int,default=14400); p.set_defaults(run=up)
    p=sub.add_parser('down');p.set_defaults(run=down)
    p=sub.add_parser('simulator');p.add_argument('--skip-build',action='store_true');p.add_argument('--runtime',default='com.apple.CoreSimulator.SimRuntime.iOS-26-3');p.set_defaults(run=simulator)
    p=sub.add_parser('pair-ui');p.set_defaults(run=pair_ui)
    p=sub.add_parser('profile');p.add_argument('name',choices=[*PROFILES,'reset']);p.add_argument('--link',choices=['phone','daemon'],default='phone');p.set_defaults(run=lambda a:profile(load(),a.name,a.link))
    p=sub.add_parser('netem');p.add_argument('--loss',type=float,default=0);p.add_argument('--delay',type=int,default=0);p.add_argument('--seed',type=int,default=1);p.add_argument('--link',choices=['phone','daemon'],default='phone');p.set_defaults(run=lambda a:netem(load(),a.loss,a.delay,a.seed,a.link))
    p=sub.add_parser('refresh');p.set_defaults(run=refresh)
    p=sub.add_parser('seed');p.add_argument('--bulk-bytes',type=int,default=5242880);p.set_defaults(run=reseed)
    p=sub.add_parser('smoke');p.set_defaults(run=lambda _:suite(['healthy','constrained','blackhole','send-reply-loss']))
    p=sub.add_parser('soak');p.add_argument('--cycles',type=int,default=100);p.add_argument('--seed',type=int,default=1);p.set_defaults(run=lambda a:suite(['flapping'],a.cycles,a.seed))
    p=sub.add_parser('replay');p.add_argument('report',type=Path);p.set_defaults(run=replay)
    p=sub.add_parser('report');p.set_defaults(run=lambda _:__import__('report').write())
    p=sub.add_parser('campaign');p.add_argument('--suite',choices=['protocol','mobile','all'],default='all');p.add_argument('--seeds',type=__import__('campaign').seeds,default=[1]);p.add_argument('--retries',type=int,choices=range(3),default=1);p.set_defaults(run=lambda a:__import__('campaign').run(a))
    p=sub.add_parser('pair-code');p.set_defaults(run=lambda _:print(pairing(load())))
    p=sub.add_parser('run');p.add_argument('--scenario',default='healthy',choices=['healthy','constrained','severe','packet-loss','blackhole','downstream-blackhole','upstream-blackhole','daemon-blackhole','bulk','send-reply-loss','restart-daemon','ui-send','ui-send-reply-loss','concurrent-reads','urgent-during-sync','draft-relaunch','model-picker','flapping','background','mobile-blackhole']);p.add_argument('--seed',type=int,default=1);p.add_argument('--cycles',type=int,default=5);p.add_argument('--outage',type=float,default=5);p.set_defaults(run=lambda a:__import__('scenarios').run(a))
    p.add_argument('--compact-index',action='store_true',help='Negotiate the same compact-sync profile as the mobile app')
    args=parser.parse_args()
    ROOT.mkdir(parents=True,exist_ok=True)
    with (ROOT/'controller.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another lab command is running; wait for it to finish')
        args.run(args)

if __name__ == '__main__':
    main()
