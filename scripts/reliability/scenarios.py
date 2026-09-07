"""Scenario runner: real encrypted RPC probe plus independently observed simulator."""
import json
import fcntl
import signal
from pathlib import Path
import queue
import random
import subprocess
import threading
import time
import uuid
import lab

class ScenarioFailure(RuntimeError):
    def __init__(self, report_path, error):
        super().__init__(str(error))
        self.report_path = report_path

class Probe:
    def __init__(self, state, directory, compact_index=False):
        lab.command(['node_modules/.bin/esbuild','scripts/reliability/probe.ts','--bundle','--platform=node',
                     '--format=esm','--packages=external','--outfile=var/reliability/probe.mjs'], capture_output=True)
        self.log = (directory/'probe.jsonl').open('w')
        self.error_log = (directory/'probe.stderr').open('w')
        self.process = subprocess.Popen(['node',str(lab.ROOT/'probe.mjs'),str(lab.STATE),
            *(['--compact-index'] if compact_index else [])],
            cwd=lab.REPO,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.error_log,text=True,bufsize=1)
        self.messages = queue.Queue()
        self.responses = {}
        self.status = None
        def read():
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                    # Store metadata only; fixture response content is unnecessary for traces.
                    self.log.write(json.dumps({k:v for k,v in message.items() if k!='result'})+'\n');self.log.flush()
                    self.messages.put(message)
                except ValueError: pass
        self.reader = threading.Thread(target=read,daemon=True);self.reader.start()
        try:
            lab.wait(lambda:self.ready(),timeout=45,description='encrypted probe session')
        except BaseException:
            # The caller has no Probe instance yet when construction fails.
            # Close here so a failed case cannot leave a client in the next run.
            self.close()
            raise
    def pump(self):
        if self.process.poll() is not None:
            raise RuntimeError('Probe exited; see probe.stderr')
        while True:
            try: message=self.messages.get_nowait()
            except queue.Empty: break
            if message.get('event')=='status': self.status=message['status']
            if 'id' in message:self.responses[message['id']]=message
    def ready(self):
        self.pump(); return self.status=='encrypted'
    def send(self, method, params=None):
        identifier=uuid.uuid4().hex
        self.process.stdin.write(json.dumps({'id':identifier,'method':method,'params':params or {}})+'\n')
        self.process.stdin.flush();return identifier
    def response(self, identifier, timeout=45):
        def check():
            self.pump(); return self.responses.pop(identifier,None)
        return lab.wait(check,timeout=timeout,description='RPC response')
    def rpc(self, method, params=None, timeout=45):
        response=self.response(self.send(method,params),timeout)
        if not response['ok']:raise AssertionError(response['error'])
        return response
    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        self.reader.join(timeout=2)
        self.process.stdin.close();self.process.stdout.close()
        self.log.close();self.error_log.close()


def execution_count(state, operation):
    path=Path(state['data_root'])/'ledger.jsonl'
    return sum(1 for line in path.read_text().splitlines() if
               (event:=json.loads(line)).get('stage')=='execution' and event.get('operation')==operation)


def run(args):
    if not 1 <= args.cycles <= 100 or not 0 <= args.outage <= 300:
        raise ValueError('Runs are bounded to 1–100 cycles and 0–300 seconds of outage')
    with (lab.ROOT/'scenario.lock').open('w') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('Another scenario is already running')
        def expired(*_): raise TimeoutError('Scenario watchdog deadline exceeded')
        previous=signal.signal(signal.SIGALRM,expired)
        signal.alarm(int(180+args.cycles*60+args.outage))
        try: return _run(args)
        finally: signal.alarm(0);signal.signal(signal.SIGALRM,previous)


def _run(args):
    state=lab.load()
    run_id=time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    directory=lab.ROOT/'runs'/run_id;directory.mkdir(parents=True)
    randomizer=random.Random(args.seed)
    report={'run':run_id,'commit':lab.output(['git','rev-parse','HEAD']),
            'daemon_sha256':state['processes']['daemon'].get('sha256'),
            'relay_sha256':state['processes']['relay'].get('sha256'),
            'dirty':lab.output(['git','status','--short']), 'seed':args.seed,'scenario':args.scenario,
            'fixture':state['fixture'], 'outage':args.outage, 'cycles':args.cycles,'app_sha256':state.get('app_sha256'),
            'compact_index':getattr(args,'compact_index',False), 'steps':[], 'passed':False}
    probe=None
    def step(name, **data):
        event={'name':name,'at':time.monotonic(),**data};report['steps'].append(event)
        (directory/'report.json').write_text(json.dumps(report,indent=2))
        print(name,flush=True)
    def set_profile(name,link='phone'):
        lab.profile(state,name,link);step('network',profile=name,link=link)
    def calibrate():
        samples=[]
        for _ in range(3):
            start=time.monotonic();lab.http(state['phone_url']+'/health')
            samples.append((time.monotonic()-start)*1000)
        step('path.calibration',http_rtt_ms=samples)

    try:
        lab.netem(state)
        set_profile('healthy');set_profile('healthy','daemon')
        calibrate()
        probe=Probe(state,directory,compact_index=report['compact_index'])
        baseline=probe.rpc('sync.index');step('baseline',duration_ms=baseline['duration_ms'],bytes=baseline['bytes'])
        snapshot=baseline['result']['snapshot']
        workspace=snapshot['workspaces'][0]['id'];thread=snapshot['threads'][0]['id']
        def control():return probe.rpc('sync.index')
        def mobile_state():
            return lab.http(f"http://127.0.0.1:{state['trace_port']}")
        if args.scenario in ['healthy','constrained','severe','packet-loss']:
            set_profile('constrained' if args.scenario=='packet-loss' else args.scenario)
            if args.scenario=='packet-loss':
                lab.netem(state,loss=1,delay=50,seed=args.seed);step('netem',loss=1,delay_ms=50,seed=args.seed)
            calibrate()
            samples=[]
            for _ in range(args.cycles):
                result=control();samples.append(result['duration_ms'])
            step('rpc.samples',samples_ms=samples)
            if report['compact_index'] and args.scenario=='constrained':
                assert max(samples)<3000, 'Compact project sync exceeded 3s on the constrained link'
        elif args.scenario in ['blackhole','downstream-blackhole','upstream-blackhole','daemon-blackhole']:
            link='daemon' if args.scenario=='daemon-blackhole' else 'phone'
            profile_name='blackhole' if link=='daemon' else args.scenario
            set_profile(profile_name,link)
            pending=probe.send('sync.index')
            time.sleep(args.outage)
            set_profile('reset',link);set_profile('healthy',link)
            response=probe.response(pending);step('interrupted.request',ok=response['ok'],duration_ms=response['duration_ms'])
            restored=time.monotonic()
            lab.wait(lambda:probe.ready(),timeout=45,description='probe reconnect')
            result=control();step('recovered',duration_ms=(time.monotonic()-restored)*1000)
        elif args.scenario in ['concurrent-reads','urgent-during-sync']:
            set_profile('constrained')
            # Queue a burst before awaiting any response to exercise independent dispatch.
            pending=[probe.send('sync.index') for _ in range(12)]
            if args.scenario=='urgent-during-sync':
                operation='LAB-'+uuid.uuid4().hex
                sent=time.monotonic()
                urgent=probe.send('turn.start',{'workspace_id':workspace,'thread_id':thread,'inputs':[{'type':'text','text':operation}]})
                lab.wait(lambda:execution_count(state,operation)>0,timeout=5,description='urgent execution during sync')
                execution_ms=(time.monotonic()-sent)*1000
                response=probe.response(urgent)
                step('urgent.result',ok=response['ok'],duration_ms=response['duration_ms'],execution_ms=execution_ms)
                assert response['ok'], 'Urgent send failed during sync'
                assert response['duration_ms']<5000, 'Urgent acknowledgement stalled behind sync'
                assert execution_count(state,operation)==1, 'Urgent send executed more than once'
            responses=[probe.response(identifier) for identifier in pending]
            step('concurrent.results',results=[{k:v for k,v in r.items() if k!='result'} for r in responses])
            accepted=[r for r in responses if r['ok']]
            rejected=[r for r in responses if not r['ok']]
            assert accepted, 'No concurrent index request made progress'
            # The daemon intentionally bounds admission; overload must fail promptly,
            # without executing or poisoning the next request once slots are released.
            assert all('Desktop is busy; this request was not executed.' in r.get('error','') and r['duration_ms']<2000 for r in rejected), 'Unexpected or slow overload failure'
            expected={t['id'] for t in snapshot['threads']}
            assert all({t['id'] for t in r['result']['snapshot']['threads']}==expected for r in accepted), 'Concurrent index lost threads'
            result=control();step('concurrent.recovered',duration_ms=result['duration_ms'],accepted=len(accepted),rejected=len(rejected))
        elif args.scenario=='bulk':
            set_profile('constrained')
            pending=probe.send('thread.detail',{'workspace_id':workspace,'thread_id':'lab-thread-0'})
            samples=[probe.rpc('thread.mark_read',{'workspace_id':workspace,'thread_id':thread,'read_seq':0})['duration_ms'] for _ in range(10)]
            step('bulk.control',samples_ms=samples)
            bulk=probe.response(pending,timeout=120)
            step('bulk',ok=bulk['ok'],bytes=bulk.get('bytes'),duration_ms=bulk['duration_ms'])
            assert bulk['ok'],bulk
            assert bulk['bytes']>=state['fixture']['bulk_bytes'], 'Bulk fixture was not transferred'
            assert sorted(samples)[-1]<2000, 'Small RPC exceeded 2s during bulk transfer'
        elif args.scenario=='send-reply-loss':
            operation='LAB-'+uuid.uuid4().hex
            set_profile('downstream-blackhole')
            pending=probe.send('turn.start',{'workspace_id':workspace,'thread_id':thread,'inputs':[{'type':'text','text':operation}]})
            lab.wait(lambda:execution_count(state,operation)>0,timeout=30,description='fixture execution')
            set_profile('reset');set_profile('healthy')
            response=probe.response(pending);step('send.outcome',ok=response['ok'])
            lab.wait(lambda:probe.ready(),timeout=45)
            detail=probe.rpc('thread.detail',{'workspace_id':workspace,'thread_id':thread})
            assert operation in json.dumps(detail['result']), 'Executed message missing from recovered history'
            assert execution_count(state,operation)==1,'Duplicate execution'
            step('send.reconciled',executions=1)
        elif args.scenario=='restart-daemon':
            record=state['processes']['daemon']
            lab.stop_process(state,'daemon')
            lab.wait(lambda:subprocess.run(['kill','-0',str(record['pid'])],capture_output=True).returncode!=0,
                     timeout=15,description='old test daemon exit')
            lab.start_process(state,'daemon',record['args'],state['daemon_env'])
            lab.wait(lambda:read_ready(probe),timeout=60,description='daemon RPC registration recovery')
            step('daemon.restarted')
        elif args.scenario in ['ui-send','ui-send-reply-loss','draft-relaunch','model-picker']:
            if not state.get('simulator'):raise RuntimeError('Pair the simulator first')
            if any(n.get('AXLabel')=='Close sidebar' and n.get('frame',{}).get('x',-1)>=0 for n in lab.nodes(lab.ui(state))):
                lab.tap(state,'Close sidebar')
            lab.wait(lambda:any(n.get('AXUniqueId')=='message-composer' for n in lab.nodes(lab.ui(state))),
                     description='composer')
            if args.scenario=='model-picker':
                label=next(n['AXLabel'] for n in lab.nodes(lab.ui(state)) if (n.get('AXLabel') or '').startswith('Agent and model:'))
                lab.tap(state,label)
                lab.wait(lambda:any(n.get('AXLabel')=='Default' for n in lab.nodes(lab.ui(state))),description='model choices')
                lab.tap(state,'Default');step('model.selected')
            else:
                operation='LAB-'+uuid.uuid4().hex
                lab.fill(state,'Message',operation)
                if args.scenario=='draft-relaunch':
                    lab.command(['axe','button','home','--udid',state['simulator']])
                    time.sleep(1)
                    lab.command(['xcrun','simctl','terminate',state['simulator'],lab.BUNDLE])
                    lab.command(['xcrun','simctl','launch',state['simulator'],lab.BUNDLE])
                    lab.wait(lambda:any(n.get('AXValue')==operation for n in lab.nodes(lab.ui(state))),
                             timeout=20,description='restored draft')
                    step('draft.restored')
                else:
                    if args.scenario=='ui-send-reply-loss':
                        set_profile('downstream-blackhole')
                    lab.tap(state,'Send message')
                    lab.wait(lambda:execution_count(state,operation)>0,timeout=30,description='UI message execution')
                    if args.scenario=='ui-send-reply-loss':
                        step('send.executed.before.reply',executions=execution_count(state,operation))
                        time.sleep(args.outage)
                        set_profile('reset');set_profile('healthy')
                    lab.wait(lambda:('RECEIVED '+operation) in json.dumps(lab.ui(state)),timeout=30,description='visible response')
                    assert execution_count(state,operation)==1
                    lab.wait(lambda:any(n.get('AXUniqueId')=='message-composer' and operation not in (n.get('AXValue') or '')
                                        for n in lab.nodes(lab.ui(state))),
                             timeout=5,description='delivered message removed from composer')
                    step('ui.send.confirmed',executions=1)
            lab.capture(state,directory,'ui-complete')
        elif args.scenario=='flapping':
            for index in range(args.cycles):
                link=randomizer.choice(['phone','daemon'])
                set_profile('blackhole',link);time.sleep(randomizer.uniform(.2,2))
                set_profile('reset',link);set_profile('healthy',link)
                lab.wait(lambda:probe.ready(),timeout=45)
                # Presence may precede daemon registration. Retry reads, never mutations.
                lab.wait(lambda:read_ready(probe),timeout=45,description='post-flap read')
                memory=lab.output(['ps','-p',str(state['processes']['daemon']['pid']),'-o','rss=']).strip()
                step('flap.recovered',cycle=index,daemon_rss_kb=int(memory))
        elif args.scenario in ['background','mobile-blackhole']:
            if not state.get('simulator') or not state.get('trace_port'):
                raise RuntimeError('Install and pair the instrumented simulator first')
            lab.wait(lambda:mobile_state().get('relay.state',{}).get('synced'),description='mobile synced')
            if args.scenario=='background':
                lab.command(['axe','button','home','--udid',state['simulator']])
            set_profile('downstream-blackhole' if args.scenario=='mobile-blackhole' else 'blackhole')
            time.sleep(args.outage)
            if args.scenario=='mobile-blackhole' and args.outage>=50:
                status=mobile_state().get('relay.state',{}).get('status')
                assert status!='encrypted', 'Silent dead mobile socket stayed Connected'
            set_profile('healthy')
            restored=time.time()
            lab.command(['xcrun','simctl','launch',state['simulator'],lab.BUNDLE])
            def recovered():
                status=mobile_state().get('relay.state',{})
                return status.get('received_at',0)>restored and status.get('status')=='encrypted'
            lab.wait(recovered,timeout=15,description='mobile recovery')
            step('mobile.recovered',duration_ms=(time.time()-restored)*1000)
            lab.capture(state,directory,'recovered')
        else:raise ValueError(args.scenario)
        report['passed']=True
    except BaseException as error:
        report['error']=str(error)
        lab.capture(state,directory,'failure')
        if isinstance(error, Exception):
            raise ScenarioFailure(directory/'report.json', error) from error
        raise
    finally:
        try:lab.netem(state)
        except (OSError,subprocess.CalledProcessError):pass
        for link in ['phone','daemon']:
            try:lab.profile(state,'healthy',link)
            except OSError:pass
        if probe:probe.close()
        (directory/'report.json').write_text(json.dumps(report,indent=2))
        print(f'Report: {directory}/report.json',flush=True)
    return directory/'report.json'


def read_ready(probe):
    try:return probe.rpc('sync.index',timeout=40)['ok']
    except (AssertionError, TimeoutError):return False
