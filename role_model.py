"""Single source for role scores and the numerical explanations shown to analysts."""
import numpy as np
import pandas as pd

PRIORITY_WEIGHTS = {'role':.24,'confidence':.14,'activity':.22,'structure':.20,'temporal':.10,'coverage':.10}


def role_model(f):
    low = 1-np.maximum(f.in_tx_pct,f.out_tx_pct)
    both = (f.in_deg>0)&(f.out_deg>0)
    gates = {
        'consolidator':((f.in_deg>=3)&~f.is_seed, 'Не менее 3 плательщиков; клиент не seed'),
        'distributor':(f.out_deg>=3,'Не менее 3 получателей'),
        'transit':(both&~f.is_seed,'Есть вход и выход; клиент не seed'),
        'terminal':((f.out_deg==0)&(f.in_deg>0),'Есть входящие и нет наблюдаемых исходящих; глубина 4 снижает скор'),
        'coordinator':(both&((f.upstream_seed_count>=2)|f.is_articulation|(f.cross_cluster_count>=2)),
                       'Есть вход и выход; ≥2 seed-ветвей, или точка сочленения, или ≥2 соседних кластеров'),
        'peripheral':(pd.Series(True,index=f.index),'Базовая гипотеза при слабых признаках остальных ролей')}
    terminal_base = np.where(f.truncated_by_depth,.20,.48)
    terminal_factor = np.where(f.truncated_by_depth,.45,.52)
    parts = {
        'consolidator':{'Разнообразие плательщиков':.29*f.in_deg_pct,'Входящая сумма':.20*f.in_kzt_pct,
            'Количество входящих операций':.16*f.in_tx_pct,'Узкий выход':.12*(1-f.out_deg_pct),
            'Сходящиеся seed-ветви':.13*f.upstream_seed_count_pct,'PageRank':.10*f.pagerank_pct},
        'distributor':{'Разнообразие получателей':.31*f.out_deg_pct,'Исходящая сумма':.22*f.out_kzt_pct,
            'Количество исходящих операций':.17*f.out_tx_pct,'Распределённость исходящего объёма':.10*(1-f.out_concentration),
            'Посредничество':.10*f.betweenness_pct,'Seed-ветви':.10*f.upstream_seed_count_pct},
        'transit':{'Совпадение потоков в один день':.30*f.same_day_ratio,'Баланс наблюдаемых потоков':.24*f.flow_balance,
            'Дни с входом и выходом':.15*f.both_direction_days.clip(upper=3)/3,'Посредничество':.13*f.betweenness_pct,
            'Активные дни':.10*f.active_days_pct,'Сходство числа контрагентов':.08*(1-np.abs(f.in_deg_pct-f.out_deg_pct))},
        'terminal':{'Отсутствие наблюдаемого выхода с поправкой на глубину':pd.Series(terminal_base,index=f.index),
            'Входящая сумма':terminal_factor*.38*f.in_kzt_pct,'Входящие операции':terminal_factor*.28*f.in_tx_pct,
            'Плательщики':terminal_factor*.20*f.in_deg_pct,'Активные дни':terminal_factor*.14*f.active_days_pct},
        'coordinator':{'Посредничество':.27*f.betweenness_pct,'Сходящиеся seed-ветви':.23*f.upstream_seed_count_pct,
            'Связи с разными кластерами':.18*f.cross_cluster_count_pct,'PageRank':.12*f.pagerank_pct,
            'Разнообразие плательщиков':.10*f.in_deg_pct,'Разнообразие получателей':.10*f.out_deg_pct,
            'Точка сочленения':.08*f.is_articulation.astype(float)},
        'peripheral':{'Базовый скор':pd.Series(.30,index=f.index),'Низкая активность':.55*low,
            'Не более одной связи':.15*(f.in_deg+f.out_deg<=1)}}
    scores = pd.DataFrame({role:sum(values.values()).clip(0,1)*gates[role][0] for role,values in parts.items()},index=f.index)
    isolates=(f.in_deg==0)&(f.out_deg==0)
    scores.loc[isolates,'peripheral']=1.
    return scores,parts,gates


def priority_features(f,role_risk):
    return pd.DataFrame({'role':f.role.map(role_risk),'confidence':f.role_score,
        'activity':np.maximum.reduce([f.in_kzt_pct,f.out_kzt_pct,f.in_tx_pct,f.out_tx_pct]),
        'structure':np.maximum.reduce([f.betweenness_pct,f.pagerank_pct,f.upstream_seed_count_pct]),
        'temporal':np.maximum(f.same_day_ratio,f.in_cycle.astype(float)*.65),'coverage':f.observability},index=f.index)
