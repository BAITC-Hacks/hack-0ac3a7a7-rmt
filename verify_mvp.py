"""Check all dossier explanations and optionally the running demo/CSV consistency."""
import argparse
import json
import math
from pathlib import Path
import time
import urllib.request

from provenance import verify_manifest
from server import Snapshot
from validate import validate


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data',default='data')
    parser.add_argument('--out',default='out')
    parser.add_argument('--server',help='Optional local URL, e.g. http://127.0.0.1:8000')
    args=parser.parse_args()
    data,out=Path(args.data),Path(args.out)
    validate(data,out)
    manifest=verify_manifest(data,out)
    snap=Snapshot(data,out,'verification','Verification')
    for c in snap.nodes:
        a=snap.analysis['nodes'][c['gid']]
        assert a['winner']==c['role']
        assert math.isclose(min(1,sum(t['contribution'] for t in a['terms'])),c['role_score'],abs_tol=1e-12)
        assert math.isclose(sum(t['contribution'] for t in a['priority_terms']),c['priority_raw'],abs_tol=1e-12)
        for r in a['roles']: assert math.isclose(r['score'],c['score_'+r['role']],abs_tol=1e-12)
        path=snap.seed_path(c['gid'])
        if path['nodes']:
            assert snap.by_id[path['nodes'][0]]['is_seed'] and path['nodes'][-1]==c['gid']
            assert len(path['edges'])<=4
        assert 0<=a['temporal']['ratio']<=1
    print(f'All {len(snap.nodes)} explanations and seed paths: OK; pipeline {manifest["elapsed_seconds"]:.3f}s')
    if args.server:
        base=args.server.rstrip('/')
        def fetch(path):
            with urllib.request.urlopen(base+path,timeout=15) as response: return response.read()
        state=json.loads(fetch('/api/state'))
        assert {c['gid'] for c in state['nodes']}==set(snap.by_id),'Server has a different active dataset'
        for name,expected in snap.downloads.items():
            assert fetch('/out/'+name+'?version='+state['version'])==expected,f'{name} differs from out'
        timings=[]
        samples=list(dict.fromkeys([snap.nodes[0]['gid']]+[next(c['gid'] for c in snap.nodes if c['role']==r) for r in sorted({c['role'] for c in snap.nodes})]))
        for gid in samples:
            started=time.perf_counter()
            result=json.loads(fetch('/api/node/'+gid+'?version='+state['version']))
            timings.append((time.perf_counter()-started)*1000)
            assert result['analysis']==snap.analysis['nodes'][gid]
            assert result['seed_path']==snap.seed_path(gid)
        print(f'Live CSV and {len(samples)} dossiers: OK; max observed response {max(timings):.1f}ms (not a load benchmark)')


if __name__=='__main__': main()
