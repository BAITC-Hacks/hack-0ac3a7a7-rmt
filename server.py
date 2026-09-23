"""Local AML service: immutable datasets, background import, grounded query agent."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import networkx as nx
import pandas as pd

import graph_agent
from validate import validate
from provenance import verify_manifest

ROOT = Path(__file__).resolve().parent
FILES = ('nodes.parquet','edges.parquet','transactions.parquet')
MAX_BODY = 36 * 1024 * 1024
MAX_UPLOAD = 25 * 1024 * 1024


def compile_dataset(data, out):
    result = subprocess.run([sys.executable,str(ROOT/'starter.py'),'--data',str(data),'--out',str(out)],
                            cwd=ROOT,capture_output=True,encoding='utf-8',errors='replace',timeout=240,
                            env={**os.environ,'PYTHONIOENCODING':'utf-8'})
    if result.returncode:
        # Keep the final diagnostic, not stack traces with server filesystem paths.
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise ValueError(detail[-1][:350] if detail else 'Не удалось обработать файлы')
    validate(data,out)


def read_csv(path):
    with path.open(encoding='utf-8-sig',newline='') as source: return list(csv.DictReader(source))


class Snapshot:
    def __init__(self, data, out, version, label):
        self.data,self.out,self.version = Path(data),Path(out),version
        self.manifest=verify_manifest(self.data,self.out)
        self.analysis=json.loads((self.out/'analysis.json').read_text(encoding='utf-8'))
        self.downloads={name:(self.out/name).read_bytes() for name in ('nodes_roles.csv','clusters.csv','top_nodes.csv')}
        numeric_int = {'cluster_id','depth','in_deg','out_deg','in_tx','out_tx','upstream_seed_count','reciprocal_deg','cross_cluster_count'}
        bool_cols = {'is_seed','truncated_by_depth','in_cycle','is_articulation'}
        self.nodes=[]
        for raw in read_csv(self.out/'nodes_roles.csv'):
            c={}
            for k,v in raw.items():
                if k in {'gid','role','evidence'}: c[k]=v
                elif k in bool_cols: c[k]=v.lower()=='true'
                elif k in numeric_int: c[k]=int(float(v))
                else: c[k]=float(v)
            c['id']=c['gid']
            c['truncated']=c['truncated_by_depth']
            self.nodes.append(c)
        self.nodes.sort(key=lambda c:(-c['priority_score'],int(c['gid'])))
        self.by_id={c['gid']:c for c in self.nodes}
        edges=pd.read_parquet(self.data/'edges.parquet')
        self.edges=[{'from':str(int(r.src)),'to':str(int(r.dst)),'sum_kzt':float(r.sum_kzt),'n_tx':int(r.n_tx)} for r in edges.itertuples()]
        self.graph=nx.DiGraph()
        self.graph.add_nodes_from(self.by_id)
        self.graph.add_edges_from((e['from'],e['to']) for e in self.edges)
        self.adjacency={gid:[] for gid in self.by_id}
        for edge in self.edges:
            self.adjacency[edge['from']].append(edge)
            if edge['to'] != edge['from']: self.adjacency[edge['to']].append(edge)
        self.clusters=[]
        for row in read_csv(self.out/'clusters.csv'):
            self.clusters.append({**row,**{k:int(row[k]) for k in ['cluster_id','n_nodes','n_seed']},'sum_kzt_internal':float(row['sum_kzt_internal'])})
        self.top=read_csv(self.out/'top_nodes.csv')
        self.tx=pd.read_parquet(self.data/'transactions.parquet')
        self.tx['date']=pd.to_datetime(self.tx['date']).dt.strftime('%Y-%m-%d')
        self.edge_by_pair={(e['from'],e['to']):e for e in self.edges}
        self.paths={c['gid']:[c['gid']] for c in sorted(self.nodes,key=lambda c:int(c['gid'])) if c['is_seed']}
        queue=deque(self.paths)
        while queue:
            source=queue.popleft()
            if len(self.paths[source])>4: continue
            for target in sorted(self.graph.successors(source),key=int):
                if target not in self.paths:
                    self.paths[target]=self.paths[source]+[target]
                    queue.append(target)
        self.meta={'label':label,'nodes':len(self.nodes),'edges':len(self.edges),'transactions':len(self.tx),
            'seeds':sum(c['is_seed'] for c in self.nodes),'truncated':sum(c['truncated'] for c in self.nodes),
            'volume_kzt':float(edges.sum_kzt.sum()),'date_from':None if self.tx.empty else str(self.tx.date.min()),
            'date_to':None if self.tx.empty else str(self.tx.date.max()),
            'minimum_observed_kzt':None if self.tx.empty else float(self.tx.sum_kzt.min()),
            'max_depth':max(c['depth'] for c in self.nodes)}
        self.payload=json.dumps({'version':version,'meta':self.meta,'nodes':self.nodes,'edges':self.edges,
            'clusters':self.clusters,'top':self.top,'audit':{'stability':self.analysis['stability'],
            'elapsed_seconds':self.manifest['elapsed_seconds']}},ensure_ascii=False,allow_nan=False).encode()

    def seed_path(self,gid):
        nodes=self.paths.get(gid,[])
        return {'nodes':nodes,'edges':[self.edge_by_pair[(a,b)] for a,b in zip(nodes,nodes[1:])],
            'note':'Один кратчайший направленный путь от seed, до 4 переходов. Суммы — за весь период; непрерывное движение одних и тех же денег не установлено.' if nodes else
                   'Направленный путь от seed в пределах 4 переходов не найден в наблюдаемых данных.'}

    def neighbors(self,gid,direction='both'):
        return sorted((e for e in self.adjacency[gid] if direction=='both' or
                      (e['from']==gid if direction=='out' else e['to']==gid)),key=lambda e:-e['sum_kzt'])

    def daily(self,gid):
        tx=self.tx[(self.tx.src==int(gid)) | (self.tx.dst==int(gid))]
        return [{'date':str(date),'incoming':float(day.loc[day.dst==int(gid),'sum_kzt'].sum()),
                 'outgoing':float(day.loc[day.src==int(gid),'sum_kzt'].sum()),'n_tx':len(day)} for date,day in tx.groupby('date',sort=True)]


class Store:
    def __init__(self, runtime, demo, restore=True):
        self.runtime=Path(runtime)
        self.runtime.mkdir(parents=True,exist_ok=True)
        self.demo=demo
        self.snapshot=demo
        self.lock=threading.Lock()
        self.chat_slots=threading.BoundedSemaphore(2)
        self.job={'state':'idle','stage':'Готово','progress':0}
        self.notice=''
        if restore and (self.runtime/'active.json').exists():
            try:
                info=json.loads((self.runtime/'active.json').read_text(encoding='utf-8'))
                version=info['version']
                if len(version)!=32 or any(c not in '0123456789abcdef' for c in version): raise ValueError('Bad version')
                folder=self.runtime/'datasets'/version
                validate(folder/'data',folder/'out')
                self.snapshot=Snapshot(folder/'data',folder/'out',version,'Загруженный датасет')
            except Exception:
                self.notice='Сохранённый датасет не прошёл восстановление. Открыты исходные данные; загрузите нужные файлы повторно.'
                print('Saved dataset could not be restored; using demo.',flush=True)

    def status(self):
        with self.lock:
            return {'version':self.snapshot.version,'job':dict(self.job),'agent':graph_agent.configuration(),'notice':self.notice}

    def start_import(self, files):
        if not isinstance(files,dict) or set(files)!=set(FILES): raise ValueError('Нужны ровно nodes.parquet, edges.parquet и transactions.parquet')
        decoded={}
        for name in FILES:
            try: decoded[name]=base64.b64decode(files[name],validate=True)
            except Exception as exc: raise ValueError(f'{name}: некорректное содержимое') from exc
            if not decoded[name].startswith(b'PAR1') or not decoded[name].endswith(b'PAR1'): raise ValueError(f'{name}: не распознан формат Parquet')
        if sum(map(len,decoded.values())) > MAX_UPLOAD: raise ValueError('Суммарный размер файлов должен быть не более 25 МБ')
        with self.lock:
            if self.job['state']=='running': raise RuntimeError('Другой импорт уже выполняется')
            version=uuid.uuid4().hex
            self.job={'id':version,'state':'running','stage':'Проверка файлов и расчёт признаков','progress':15}
        threading.Thread(target=self._import,args=(version,decoded),daemon=True).start()
        return self.status()

    def _import(self,version,files):
        folder=self.runtime/'datasets'/version
        try:
            data,out=folder/'data',folder/'out'
            data.mkdir(parents=True)
            for name,content in files.items(): (data/name).write_bytes(content)
            compile_dataset(data,out)
            with self.lock: self.job.update(stage='Проверка выгрузок и подготовка графа',progress=85)
            snapshot=Snapshot(data,out,version,'Загруженный датасет')
            pointer=self.runtime/'active.tmp'
            pointer.write_text(json.dumps({'version':version}),encoding='utf-8')
            os.replace(pointer,self.runtime/'active.json')
            with self.lock:
                self.snapshot=snapshot
                self.notice=''
                self.job.update(state='succeeded',stage='Новые данные готовы',progress=100,version=version)
        except Exception as exc:
            detail='Расчёт превысил лимит 4 минуты' if isinstance(exc,subprocess.TimeoutExpired) else str(exc)[:400] or 'Проверка результатов не пройдена'
            with self.lock: self.job.update(state='failed',stage=detail,progress=0)

    def reset_demo(self):
        with self.lock:
            if self.job['state']=='running': raise RuntimeError('Дождитесь окончания импорта')
            (self.runtime/'active.json').unlink(missing_ok=True)
            self.snapshot=self.demo
            self.notice=''
            self.job={'state':'idle','stage':'Открыт исходный датасет','progress':0}


class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,store):
        self.store=store
        super().__init__(address,Handler)


class Handler(BaseHTTPRequestHandler):
    server_version='FreedomLocal/1.0'

    def log_message(self,format,*args):
        # Avoid printing queries, credentials or uploaded contents.
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(40)

    def send_data(self,status,payload,content_type='application/json; charset=utf-8',download=None):
        if not isinstance(payload,bytes): payload=json.dumps(payload,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(payload)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        if download: self.send_header('Content-Disposition',f'attachment; filename="{download}"')
        self.end_headers()
        try: self.wfile.write(payload)
        except (BrokenPipeError,ConnectionResetError): pass

    def dispatch(self,post=False):
        try:
            # Loopback service only. Reject DNS rebinding and cross-origin mutations.
            allowed={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
            host=self.headers.get('Host','')
            if host not in allowed: return self.send_data(403,{'error':'Недопустимый Host'})
            if post and self.headers.get('Origin') not in {None,'http://'+host}:
                return self.send_data(403,{'error':'Запрос с другого сайта запрещён'})
            if post and self.headers.get('Sec-Fetch-Site')=='cross-site':
                return self.send_data(403,{'error':'Запрос с другого сайта запрещён'})
            url=urlparse(self.path)
            path=url.path
            store=self.server.store
            snap=store.snapshot
            if not post:
                if path=='/api/status': return self.send_data(200,store.status())
                if path=='/api/state': return self.send_data(200,snap.payload)
                if path=='/api/brief': return self.send_data(200,graph_agent.respond(snap,'Обзор сети',use_model=False))
                if path.startswith('/api/node/'):
                    gid=path.removeprefix('/api/node/')
                    version=parse_qs(url.query).get('version',[snap.version])[0]
                    if version!=snap.version: return self.send_data(409,{'error':'Датасет изменился; обновите страницу'})
                    if gid not in snap.by_id: return self.send_data(404,{'error':'GID не найден'})
                    return self.send_data(200,{'version':snap.version,'client':snap.by_id[gid],'neighbors':snap.neighbors(gid),'daily':snap.daily(gid),
                        'analysis':snap.analysis['nodes'][gid],'seed_path':snap.seed_path(gid)})
                if path.startswith('/out/') and path[5:] in {'nodes_roles.csv','clusters.csv','top_nodes.csv'}:
                    version=parse_qs(url.query).get('version',[snap.version])[0]
                    if version!=snap.version: return self.send_data(409,{'error':'Экспорт устарел; обновите данные'})
                    return self.send_data(200,snap.downloads[path[5:]],'text/csv; charset=utf-8',path[5:])
                static={'/':'index.html','/ui':'index.html','/ui/':'index.html',
                        '/ui/index.html':'index.html','/ui/app.js':'app.js','/ui/style.css':'style.css',
                        '/ui/workspace.css':'workspace.css'}
                if path in {'/','/ui'}:
                    self.send_response(302); self.send_header('Location','/ui/'); self.end_headers(); return
                if path in static:
                    file=ROOT/'ui'/static[path]
                    return self.send_data(200,file.read_bytes(),(mimetypes.guess_type(str(file))[0] or 'text/plain')+'; charset=utf-8')
                return self.send_data(404,{'error':'Не найдено'})
            if self.headers.get('Content-Type','').split(';')[0] != 'application/json':
                return self.send_data(415,{'error':'Нужен Content-Type: application/json'})
            size=int(self.headers.get('Content-Length','0'))
            limit=MAX_BODY if path=='/api/import' else 16384
            if size<=0 or size>limit: return self.send_data(413,{'error':'Недопустимый размер запроса'})
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError('Нужен объект JSON')
            if path=='/api/import': return self.send_data(202,store.start_import(data.get('files')))
            if path=='/api/demo': store.reset_demo(); return self.send_data(200,store.status())
            if path=='/api/chat':
                if data.get('version')!=snap.version: return self.send_data(409,{'error':'Датасет изменился; загрузите актуальные данные'})
                if not store.chat_slots.acquire(blocking=False): return self.send_data(429,{'error':'Ассистент занят. Повторите через несколько секунд.'})
                try: return self.send_data(200,graph_agent.respond(snap,data.get('message',''),data.get('selected_gid')))
                finally: store.chat_slots.release()
            return self.send_data(404,{'error':'Не найдено'})
        except RuntimeError as exc: self.send_data(409,{'error':str(exc)})
        except (ValueError,KeyError,TypeError) as exc: self.send_data(400,{'error':str(exc)[:400]})
        except Exception:
            self.send_data(500,{'error':'Внутренняя ошибка. Текущий датасет сохранён; проверьте сервер.'})

    def do_GET(self): self.dispatch()
    def do_POST(self): self.dispatch(True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--use-prebuilt',action='store_true',help='Проверить и использовать готовую папку out без повторного расчёта')
    args=parser.parse_args()
    runtime=ROOT/'.runtime'
    demo_out=ROOT/'out'
    if args.use_prebuilt:
        verify_manifest(ROOT/'data',demo_out)
        validate(ROOT/'data',demo_out)
    else:
        compile_dataset(ROOT/'data',demo_out)
    fingerprint=hashlib.sha256()
    for file in [demo_out/'nodes_roles.csv',demo_out/'analysis.json',ROOT/'data'/'edges.parquet',ROOT/'data'/'transactions.parquet']:
        fingerprint.update(file.read_bytes())
    demo=Snapshot(ROOT/'data',demo_out,'demo-'+fingerprint.hexdigest()[:12],'Исходный датасет · HackAlem')
    store=Store(runtime,demo)
    service=Server(('127.0.0.1',args.port),store)
    print(f'Freedom AML ready at http://127.0.0.1:{args.port}/ui/ | agent={graph_agent.configuration()["mode"]}',flush=True)
    try: service.serve_forever()
    except KeyboardInterrupt: pass
    finally: service.server_close()


if __name__=='__main__': main()
