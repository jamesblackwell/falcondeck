"""Summarize all measured runs, including failures. Never infer device performance."""
import json
import math
from pathlib import Path
import lab

def write():
    rows=['# Reliability lab results','', '| Run | Scenario | Result | RPC p95 | Evidence |',
          '| --- | --- | --- | --- | --- |']
    for path in sorted((lab.ROOT/'runs').glob('*/report.json')):
        result=json.loads(path.read_text())
        samples=[value for step in result['steps'] if step['name']=='rpc.samples' for value in step['samples_ms']]
        percentile=f'{sorted(samples)[math.ceil(len(samples)*.95)-1]:.0f} ms' if samples else '—'
        status='PASS' if result['passed'] else 'FAIL: '+result.get('error','incomplete')
        status=status.replace('|','/').replace('\n',' ')[:200]
        relative=path.relative_to(lab.ROOT)
        rows.append(f"| {result['run']} | {result['scenario']} | {status} | {percentile} | [report]({relative}) |")
    rows.extend(['','Failures include setup/assertion bugs discovered while building the lab; inspect each report and commit/bundle identity.',
                 'RPC latency samples are successful operations within their named scenario. A failed scenario remains failed. Simulator/AXe timings are not physical iPhone input latency.',''])
    destination=lab.ROOT/'report.md';destination.write_text('\n'.join(rows));print(destination)
