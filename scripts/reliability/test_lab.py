import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import lab
import argparse
import io
import campaign
import scenarios

class LabTests(unittest.TestCase):
    def test_failed_probe_startup_cleans_up_before_next_case(self):
        from unittest.mock import Mock
        process=Mock(stdin=io.StringIO(),stdout=io.StringIO())
        process.poll.return_value=None
        with tempfile.TemporaryDirectory() as directory, patch.object(lab,'command'), \
             patch.object(scenarios.subprocess,'Popen',return_value=process), \
             patch.object(lab,'wait',side_effect=TimeoutError('encrypted session unavailable')):
            with self.assertRaises(TimeoutError):
                scenarios.Probe({},Path(directory))
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)

    def test_campaign_retry_preserves_intermittent_failure(self):
        case=argparse.Namespace(scenario='healthy',seed=1,cycles=3,outage=0)
        attempts=iter([scenarios.ScenarioFailure(Path('/failed/report.json'),'timeout'),Path('/passed/report.json')])
        def run(_):
            value=next(attempts)
            if isinstance(value,Exception):raise value
            return value
        result=campaign.exercise(case,1,run)
        self.assertEqual(result['status'],'intermittent')
        self.assertEqual([a['passed'] for a in result['attempts']],[False,True])

    def test_campaign_stops_retrying_success_and_does_not_swallow_interrupt(self):
        case=argparse.Namespace(scenario='healthy')
        with patch.object(scenarios,'run',return_value=Path('/passed/report.json')) as run:
            self.assertEqual(campaign.exercise(case,2,run)['status'],'passed')
            self.assertEqual(run.call_count,1)
        with self.assertRaises(KeyboardInterrupt):
            campaign.exercise(case,2,lambda _: (_ for _ in ()).throw(KeyboardInterrupt()))

    def test_campaign_exhausts_failed_case_without_hiding_evidence(self):
        case=argparse.Namespace(scenario='healthy')
        with patch.object(scenarios,'run',side_effect=scenarios.ScenarioFailure(Path('/failed/report.json'),'timeout')) as run:
            result=campaign.exercise(case,1,run)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(len(result['attempts']),2)

    def test_campaign_continues_after_failure_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            state={'daemon_url':'http://localhost','phone_url':'http://localhost','fixture':{}}
            results=[]
            def exercise(case, _):
                results.append(case.scenario)
                passed=case.scenario=='second'
                return {'case':vars(case),'status':'passed' if passed else 'failed',
                        'attempts':[{'passed':passed,'report':str(root/'runs'/case.scenario/'report.json')}]}
            with patch.object(lab,'ROOT',root), patch.object(lab,'load',return_value=state), patch.object(lab,'http'), \
                 patch.object(campaign,'PROTOCOL',[('first',0),('second',0)]), patch.object(campaign,'exercise',side_effect=exercise):
                with self.assertRaises(SystemExit) as exit:
                    campaign.run(argparse.Namespace(suite='protocol',seeds=[1],retries=1))
            self.assertEqual(exit.exception.code,1)
            self.assertEqual(results,['first','second'])
            saved=json.loads(next(root.glob('campaigns/*/campaign.json')).read_text())
            self.assertEqual(saved['status'],'failures-found')
            self.assertEqual(len(saved['results']),2)

    def test_profile_changes_clear_previous_faults_before_installing_new_ones(self):
        requests=[]
        def request(url, body=None, method=None):
            requests.append((url,body,method))
            return {'toxics':[{'name':'old'}]} if body is None and method is None else {}
        with patch.object(lab,'http',side_effect=request):
            lab.profile({'env':{'LAB_PROXY_API':1234}},'blackhole')
        self.assertEqual(requests[1][2],'DELETE')
        self.assertEqual(requests[2][1],{'enabled':True})
        self.assertEqual({r[1]['stream'] for r in requests[3:]},{'upstream','downstream'})
        self.assertTrue(all(r[1]['attributes']['timeout']==0 for r in requests[3:]))

    def test_cleanup_does_not_signal_reused_pid(self):
        state={'processes':{'daemon':{'pid':4321,'args':['/isolated/lab-daemon']}}}
        with patch.object(lab.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'unrelated process')):
            with patch.object(lab.os,'killpg') as kill, patch.object(lab,'save'):
                lab.stop_process(state,'daemon')
                kill.assert_not_called()

    def test_fixture_sizes_and_identifiers_are_reproducible(self):
        from seed import write_fixture
        with tempfile.TemporaryDirectory() as directory:
            paths=write_fixture(Path(directory),50,2,10000,40)
            entries=[entry for path in paths for entry in json.loads((path/'.lab-threads.json').read_text())]
            self.assertEqual(len(entries),2000)
            self.assertEqual(len({entry['id'] for entry in entries}),2000)
            self.assertEqual(len(entries[0]['turns'][0]['items'][0]['text']),10000)

    def test_trace_tail_does_not_start_with_partial_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'trace.jsonl'
            path.write_text('{"a":123}\n{"b":456}\n')
            lines=lab.bounded_tail(path,15).decode().splitlines()
            self.assertEqual([json.loads(line) for line in lines],[{'b':456}])

    def test_fixture_records_real_execution_and_resumes_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'.lab-threads.json').write_text(json.dumps([{'id':'t','cwd':directory,'turns':[]}]))
            process=subprocess.Popen([str(lab.REPO/'scripts/reliability/fixture-codex.mjs'),'app-server'],
                 cwd=root,env={**os.environ,'FALCONDECK_LAB_ROOT':directory},
                 stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
            try:
                process.stdin.write(json.dumps({'id':1,'method':'turn/start','params':{'threadId':'t','input':[{'type':'text','text':'LAB-proof'}]}})+'\n');process.stdin.flush()
                messages=[json.loads(process.stdout.readline()) for _ in range(6)]
                self.assertEqual(messages[-1]['method'],'turn/completed')
                entries=[json.loads(line) for line in (root/'ledger.jsonl').read_text().splitlines()]
                self.assertEqual(sum(e.get('operation')=='LAB-proof' for e in entries),1)
                process.stdin.write(json.dumps({'id':2,'method':'thread/read','params':{'threadId':'t'}})+'\n');process.stdin.flush()
                response=json.loads(process.stdout.readline())
                self.assertIn('RECEIVED LAB-proof',json.dumps(response))
            finally:
                process.terminate();process.wait(timeout=5)
                process.stdin.close();process.stdout.close()

if __name__=='__main__': unittest.main()
