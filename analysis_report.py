"""Deterministic explanation, lagged observations and sensitivity audit artifacts."""
from collections import deque
from datetime import date
import json
import numpy as np

from role_model import role_model, priority_features, PRIORITY_WEIGHTS


def lagged_observations(days):
    """Allocate each unit at most once to outflow 1–2 days later. No same-day ordering assumption."""
    pending=deque(); matches=[]; total_in=0.; total_out=0.
    for day in sorted(days,key=lambda d:d['date']):
        current=date.fromisoformat(day['date'])
        while pending and (current-pending[0]['day']).days>2: pending.popleft()
        available=float(day['outgoing']); total_out+=available; total_in+=float(day['incoming'])
        for previous in pending:
            if available<=.000001: break
            amount=min(previous['remaining'],available)
            if amount<=.000001: continue
            previous['remaining']-=amount; available-=amount
            matches.append({'from_date':previous['day'].isoformat(),'to_date':current.isoformat(),
                            'lag_days':(current-previous['day']).days,'matched_kzt':round(amount,2),
                            'payers':previous.get('payers',0)})
        if day['incoming']>0:
            pending.append({'day':current,'remaining':float(day['incoming']),'payers':int(day.get('payers',0))})
    amount=sum(m['matched_kzt'] for m in matches)
    matches.sort(key=lambda m:(-m['matched_kzt'],m['from_date'],m['to_date']))
    return {'matched_kzt':round(amount,2),'incoming_kzt':total_in,'outgoing_kzt':total_out,
            'ratio':min(1.,amount/total_in) if total_in else 0.,'windows':matches[:12],'total_windows':len(matches),
            'method':'FIFO по дневным объёмам, задержка 1–2 календарных дня; каждый объём используется один раз. '
                     'Совпадение объёмов не устанавливает происхождение денег. Внутридневные совпадения исключены.'}


def daily_by_node(tx):
    result={}
    for direction,owner,other in [('incoming','dst','src'),('outgoing','src','dst')]:
        grouped=tx.groupby([owner,'date']).agg(amount=('sum_kzt','sum'),count=('sum_kzt','size'),people=(other,'nunique'))
        for (gid,when),row in grouped.iterrows():
            day=result.setdefault(str(int(gid)),{}).setdefault(str(when.date()),{'date':str(when.date()),'incoming':0.,'outgoing':0.,'payers':0,'recipients':0})
            day[direction]=float(row.amount)
            day['payers' if direction=='incoming' else 'recipients']=int(row.people)
    return {gid:sorted(days.values(),key=lambda d:d['date']) for gid,days in result.items()}


def sensitivity(frame,role_risk):
    features=priority_features(frame,role_risk)
    gids=frame.gid.to_numpy(dtype=np.int64)
    isolated=((frame.in_deg==0)&(frame.out_deg==0)).to_numpy()
    k=min(20,len(frame)); baseline=np.lexsort((gids,-frame.priority_score.to_numpy()))
    baseline_ids=set(gids[baseline[:k]])
    ranks=[]; scenarios=[]
    for name in PRIORITY_WEIGHTS:
        for factor in [.8,1.2]:
            weights=dict(PRIORITY_WEIGHTS);weights[name]*=factor
            denominator=sum(weights.values());weights={key:value/denominator for key,value in weights.items()}
            raw=sum(features[key].to_numpy()*weight for key,weight in weights.items());raw[isolated]=0
            order=np.lexsort((gids,-raw)); rank=np.empty(len(frame),dtype=int);rank[order]=np.arange(1,len(frame)+1);ranks.append(rank)
            scenarios.append({'component':name,'factor':factor,'overlap_count':len(baseline_ids & set(gids[order[:k]])),'top_size':k})
    matrix=np.array(ranks)
    return {'top_size':k,'scenarios':scenarios,'runs':len(scenarios),
        'min_overlap':min(s['overlap_count'] for s in scenarios),
        'mean_overlap':sum(s['overlap_count'] for s in scenarios)/len(scenarios),
        'scope':'Меняется по одному из 6 весов приоритета на ±20%, затем веса нормируются. Роли, признаки и граф фиксированы. Это чувствительность рейтинга, не проверка точности ролей.',
        'nodes':{str(int(gid)):{'rank_min':int(matrix[:,i].min()),'rank_max':int(matrix[:,i].max()),
                               'top_hits':int((matrix[:,i]<=k).sum()),'runs':len(scenarios)} for i,gid in enumerate(gids)}}


def export_analysis(frame,tx,out,role_risk):
    scores,parts,gates=role_model(frame)
    stability=sensitivity(frame,role_risk)
    daily=daily_by_node(tx)
    priority=priority_features(frame,role_risk)
    priority_labels={'role':'Вес роли','confidence':'Сила роли','activity':'Суммы и количество операций',
                     'structure':'Структурная значимость','temporal':'Временной сигнал / цикл','coverage':'Наблюдаемость'}
    explanations={}
    # Preserve the same tie order used by starter.score_roles.
    order=['consolidator','transit','distributor','terminal','coordinator','peripheral']
    for index,c in frame.iterrows():
        isolated=c.in_deg==0 and c.out_deg==0
        alternatives=sorted(order,key=lambda r:(-float(scores.loc[index,r]),order.index(r)))
        competing=next(role for role in alternatives if role!=c.role)
        terms=[{'label':label,'contribution':float(series.loc[index])} for label,series in parts[c.role].items()]
        if isolated: terms=[{'label':'Изолированный узел: специальное правило, 0 входящих и 0 исходящих','contribution':1.}]
        terms.sort(key=lambda t:-t['contribution'])
        explanations[str(int(c.gid))]={'winner':c.role,'winner_score':float(c.role_score),'runner_up':competing,
            'runner_score':float(scores.loc[index,competing]),'margin':float(c.role_score-scores.loc[index,competing]),
            'terms':terms,'raw_sum':sum(t['contribution'] for t in terms),
            'priority_terms':[{'label':priority_labels[key],'contribution':float(priority.loc[index,key]*weight)}
                              for key,weight in PRIORITY_WEIGHTS.items()] if not isolated else
                             [{'label':'Изолят: приоритет принудительно равен нулю','contribution':0.}],
            'priority_raw':float(c.priority_raw),
            'roles':[{'role':role,'score':float(scores.loc[index,role]),'eligible':bool(gates[role][0].loc[index]),
                      'rule':gates[role][1]} for role in alternatives],
            'temporal':lagged_observations(daily.get(str(int(c.gid)),[])),
            'stability':stability['nodes'][str(int(c.gid))]}
    report={'schema_version':1,'nodes':explanations,'stability':{k:v for k,v in stability.items() if k!='nodes'}}
    (out/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return report
