import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import lab

class LabTests(unittest.TestCase):
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
