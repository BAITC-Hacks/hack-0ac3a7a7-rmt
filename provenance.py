"""Bind compiled artifacts to exact input data and analytical source code."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
INPUTS=('nodes.parquet','edges.parquet','transactions.parquet')
OUTPUTS=('nodes_roles.csv','clusters.csv','top_nodes.csv','analysis.json')
SOURCES=('starter.py','role_model.py','analysis_report.py','provenance.py')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def signature(data,out):
    return {'inputs':{n:digest(Path(data)/n) for n in INPUTS},
            'outputs':{n:digest(Path(out)/n) for n in OUTPUTS},
            'sources':{n:digest(ROOT/n) for n in SOURCES}}

def write_manifest(data,out,elapsed):
    report={**signature(data,out),'elapsed_seconds':round(elapsed,3),'schema_version':1}
    (Path(out)/'manifest.json').write_text(json.dumps(report,indent=2),encoding='utf-8')

def verify_manifest(data,out):
    report=json.loads((Path(out)/'manifest.json').read_text(encoding='utf-8'))
    if any(report.get(key)!=value for key,value in signature(data,out).items()):
        raise ValueError('Данные, расчёт или выгрузки изменились. Выполните python run.py --skip-install.')
    return report
