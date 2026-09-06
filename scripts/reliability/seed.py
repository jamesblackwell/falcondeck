"""Deterministic native-harness fixtures, separate from product persistence."""
import json
from pathlib import Path

def write_fixture(root: Path, threads: int, lines: int, bulk_bytes: int, workspaces: int = 1):
    paths=[]
    for project in range(workspaces):
        workspace=root/('workspace' if workspaces==1 else f'workspace-{project:03}')
        workspace.mkdir(parents=True,exist_ok=True)
        entries=[]
        for index in range(threads):
            identifier=project*threads+index
            text='Lab history line.\n'*lines
            if identifier==0:
                text=('BULK-FIXTURE\n'*(bulk_bytes//13+1))[:bulk_bytes]
            entries.append({'id':f'lab-thread-{identifier}','cwd':str(workspace),
                'name':f'Lab thread {identifier:04}','preview':f'Synthetic conversation {identifier}',
                'createdAt':1780000000+identifier,'updatedAt':1780000000+identifier,
                'status':{'type':'idle'},'turns':[{'id':f'fixture-turn-{identifier}',
                'status':'completed','items':[{'id':f'fixture-item-{identifier}',
                'type':'agentMessage','text':text}]}]})
        (workspace/'.lab-threads.json').write_text(json.dumps(entries))
        paths.append(workspace)
    return paths
