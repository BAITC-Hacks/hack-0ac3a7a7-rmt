#!/usr/bin/env python3
"""Freedom AML: deterministic analysis of the four-hop transaction graph.

One command builds the three CSV files required by the case and graph_data.js
for the demo UI. Every role is derived from explainable graph/temporal features.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

ROLES = ["consolidator", "transit", "distributor", "terminal", "coordinator", "peripheral"]
ROLE_RISK = {"coordinator": 1.0, "consolidator": .92, "distributor": .86,
             "transit": .72, "terminal": .55, "peripheral": .08}
RANDOM_SEED = 42


def load(data_dir: Path):
    schemas = {'nodes':['gid','depth','is_seed'], 'edges':['src','dst','sum_kzt','n_tx','depth'],
               'transactions':['src','dst','date','sum_kzt']}
    for name, limit in [('nodes', 10000), ('edges', 100000), ('transactions', 500000)]:
        parquet = pq.ParquetFile(data_dir / f'{name}.parquet')
        metadata = parquet.metadata
        missing = set(schemas[name]) - set(parquet.schema_arrow.names)
        if missing:
            raise ValueError(f'{name}: отсутствуют колонки {", ".join(sorted(missing))}')
        if metadata.num_rows > limit:
            raise ValueError(f'{name}: превышен лимит локальной версии ({limit} строк)')
        if sum(metadata.row_group(i).total_byte_size for i in range(metadata.num_row_groups)) > 128*1024*1024:
            raise ValueError(f'{name}: распакованный файл превышает 128 МБ')
    edges = pd.read_parquet(data_dir / "edges.parquet", columns=['src','dst','sum_kzt','n_tx','depth'])
    nodes = pd.read_parquet(data_dir / "nodes.parquet", columns=['gid','depth','is_seed'])
    tx = pd.read_parquet(data_dir / "transactions.parquet", columns=['src','dst','date','sum_kzt'])
    if 'date' not in tx:
        raise ValueError('transactions: отсутствует колонка date')
    if pd.api.types.is_numeric_dtype(tx.date):
        raise ValueError('transactions.date: нужна дата, а не числовой timestamp без единиц измерения')
    tx["date"] = pd.to_datetime(tx["date"], errors='raise').dt.normalize()
    return edges, nodes, tx


def sanity_check(edges, nodes, tx):
    specs = [(edges, 'edges', ['src','dst','sum_kzt','n_tx','depth']),
             (nodes, 'nodes', ['gid','depth','is_seed']),
             (tx, 'transactions', ['src','dst','date','sum_kzt'])]
    for data, name, columns in specs:
        missing = set(columns) - set(data.columns)
        if missing:
            raise ValueError(f'{name}: отсутствуют колонки {", ".join(sorted(missing))}')
        if data[columns].isna().any().any():
            raise ValueError(f'{name}: обязательные поля содержат пропуски')
        for col in set(columns) & {'gid','src','dst','depth','n_tx'}:
            if not pd.api.types.is_integer_dtype(data[col]):
                raise ValueError(f'{name}.{col}: нужен целочисленный тип; float GID теряет точность')
        if 'sum_kzt' in columns:
            if not pd.api.types.is_numeric_dtype(data.sum_kzt) or not np.isfinite(data.sum_kzt).all() or (data.sum_kzt <= 0).any():
                raise ValueError(f'{name}.sum_kzt: нужны положительные конечные суммы')
    if nodes.empty:
        raise ValueError('nodes: нужен хотя бы один клиент')
    if not pd.api.types.is_bool_dtype(nodes.is_seed):
        raise ValueError('nodes.is_seed: нужен логический тип bool')
    if not nodes.gid.is_unique or edges[['src','dst']].duplicated().any():
        raise ValueError('Повторные GID или неагрегированные пары рёбер')
    if (nodes.gid < 0).any():
        raise ValueError('gid должен быть неотрицательным целым числом')
    if not nodes.depth.between(0,4).all() or not edges.depth.between(1,4).all():
        raise ValueError('Ожидается граф с глубиной узлов 0–4 и рёбер 1–4')
    if not (nodes.is_seed == (nodes.depth == 0)).all():
        raise ValueError('depth=0 должен совпадать с is_seed=True')
    if (edges.n_tx <= 0).any():
        raise ValueError('edges.n_tx: количество переводов должно быть положительным')
    aggregate = tx.groupby(["src", "dst"], as_index=False).agg(
        tx_sum=("sum_kzt", "sum"), tx_count=("sum_kzt", "size"))
    merged = edges.merge(aggregate, on=["src", "dst"], how="outer", indicator=True)
    if not (merged._merge == 'both').all():
        raise ValueError('edges и transactions не сходятся по парам')
    if not np.allclose(merged.sum_kzt, merged.tx_sum, rtol=0, atol=.01):
        raise ValueError('edges и transactions не сходятся по суммам (допуск 0.01 KZT)')
    if not (merged.n_tx == merged.tx_count).all():
        raise ValueError('edges и transactions не сходятся по количеству')
    graph_nodes = set(edges.src) | set(edges.dst)
    if not graph_nodes <= set(nodes.gid):
        raise ValueError('В edges присутствуют неизвестные gid')
    orphans = set(nodes.gid) - graph_nodes
    print(f"Data: {len(nodes):,} nodes, {len(edges):,} edges, {len(tx):,} transactions, "
          f"{edges.sum_kzt.sum():,.2f} KZT")
    print(f"Transactions: {len(tx)}; isolated nodes: {len(orphans)}")


def build_graph(edges, nodes):
    graph = nx.DiGraph()
    graph.add_nodes_from(int(gid) for gid in nodes.gid)
    for row in edges.itertuples(index=False):
        graph.add_edge(int(row.src), int(row.dst), sum_kzt=float(row.sum_kzt),
                       n_tx=int(row.n_tx), depth=int(row.depth))
    return graph


def weighted_pagerank(graph, alpha=.85, max_iter=200, tolerance=1e-12):
    """Deterministic PageRank without a SciPy dependency."""
    count = len(graph)
    if not count:
        return {}
    rank = {node: 1 / count for node in graph}
    outgoing = {node: sum(float(d.get("sum_kzt", 1)) for _, _, d in graph.out_edges(node, data=True))
                for node in graph}
    base = (1 - alpha) / count
    for _ in range(max_iter):
        dangling = alpha * sum(rank[n] for n, total in outgoing.items() if total == 0) / count
        updated = {node: base + dangling for node in graph}
        for source in graph:
            total = outgoing[source]
            if not total:
                continue
            factor = alpha * rank[source] / total
            for _, target, data in graph.out_edges(source, data=True):
                updated[target] += factor * float(data.get("sum_kzt", 1))
        error = sum(abs(updated[node] - rank[node]) for node in graph)
        rank = updated
        if error < tolerance:
            break
    return rank


def percentile(series):
    if len(series) <= 1:
        return pd.Series(0., index=series.index)
    return ((series.rank(method="average") - 1) / (len(series) - 1)).astype(float)


def concentration(grouped):
    frame = grouped.rename("amount").reset_index()
    owner = frame.columns[0]
    totals = frame.groupby(owner).amount.transform("sum").replace(0, np.nan)
    frame["share_sq"] = (frame.amount / totals) ** 2
    return frame.groupby(owner).share_sq.sum()


def community_features(graph):
    undirected = nx.Graph()
    undirected.add_nodes_from(graph.nodes)
    for source, target, data in graph.edges(data=True):
        strength = math.log1p(data["sum_kzt"]) * (1 + .15 * math.log1p(data["n_tx"]))
        if undirected.has_edge(source, target):
            undirected[source][target]["strength"] += strength
        else:
            undirected.add_edge(source, target, strength=strength)
    communities = nx.community.louvain_communities(
        undirected, weight="strength", resolution=1., seed=RANDOM_SEED) if undirected.number_of_edges() else [{node} for node in graph]
    ordered = sorted(communities, key=lambda group: (-len(group), min(group)))
    return {node: cid for cid, group in enumerate(ordered) for node in group}, undirected


def upstream_seed_count(graph, nodes):
    """Count seed branches through edges moving away from the discovery roots."""
    depth = nodes.set_index("gid").depth.to_dict()
    monotone = nx.DiGraph()
    monotone.add_nodes_from(graph.nodes)
    monotone.add_edges_from((s, t) for s, t in graph.edges if depth[t] > depth[s])
    result = {node: 0 for node in graph}
    for seed in nodes.loc[nodes.is_seed, "gid"]:
        for node in nx.single_source_shortest_path_length(monotone, int(seed), cutoff=4):
            result[node] += 1
    return result


def temporal_features(tx):
    incoming = tx.groupby(["dst", "date"]).sum_kzt.sum().rename("daily_in")
    outgoing = tx.groupby(["src", "date"]).sum_kzt.sum().rename("daily_out")
    daily = pd.concat([incoming, outgoing], axis=1).fillna(0.)
    daily["same_day_overlap"] = daily[["daily_in", "daily_out"]].min(axis=1)
    daily["has_both"] = (daily.same_day_overlap > 0).astype(int)
    result = daily.groupby(level=0).agg(
        same_day_overlap=("same_day_overlap", "sum"), active_days=("has_both", "size"),
        both_direction_days=("has_both", "sum"))
    result.index.name = "gid"
    return result


def compute_features(graph, edges, nodes, tx):
    frame = nodes[["gid", "depth", "is_seed"]].copy()
    mappings = {
        "in_deg": dict(graph.in_degree()), "out_deg": dict(graph.out_degree()),
        "in_kzt": dict(graph.in_degree(weight="sum_kzt")),
        "out_kzt": dict(graph.out_degree(weight="sum_kzt")),
        "in_tx": dict(graph.in_degree(weight="n_tx")), "out_tx": dict(graph.out_degree(weight="n_tx"))}
    for column, mapping in mappings.items():
        frame[column] = frame.gid.map(mapping).fillna(0)
    for column in ["in_deg", "out_deg", "in_tx", "out_tx"]:
        frame[column] = frame[column].astype(int)
    # Zero means "no observed incoming denominator"; observability carries the caveat.
    frame["pass_through"] = np.where(frame.in_kzt > 0, frame.out_kzt / frame.in_kzt, 0.0)
    frame["truncated_by_depth"] = (frame.depth == 4) & (frame.out_deg == 0)
    frame["observability"] = np.where(frame.truncated_by_depth, .45, np.where(frame.is_seed, .70, 1.))
    frame["pagerank"] = frame.gid.map(weighted_pagerank(graph)).fillna(0.)

    cluster_map, undirected = community_features(graph)
    frame["cluster_id"] = frame.gid.map(cluster_map).astype(int)
    frame["upstream_seed_count"] = frame.gid.map(upstream_seed_count(graph, nodes)).fillna(0).astype(int)
    sample_size = min(300, len(graph))
    between = nx.betweenness_centrality(
        graph, k=sample_size if sample_size < len(graph) else None,
        normalized=True, weight=None, seed=RANDOM_SEED)
    frame["betweenness"] = frame.gid.map(between).fillna(0.)
    articulation = set(nx.articulation_points(undirected))
    frame["is_articulation"] = frame.gid.isin(articulation)

    components = list(nx.strongly_connected_components(graph))
    cyclic = {node for component in components if len(component) > 1 for node in component} | set(nx.nodes_with_selfloops(graph))
    frame["in_cycle"] = frame.gid.isin(cyclic)
    reciprocal = Counter()
    for source, target in graph.edges:
        if graph.has_edge(target, source):
            reciprocal[source] += 1
    frame["reciprocal_deg"] = frame.gid.map(reciprocal).fillna(0).astype(int)

    frame["in_concentration"] = frame.gid.map(
        concentration(edges.groupby(["dst", "src"]).sum_kzt.sum())).fillna(0.)
    frame["out_concentration"] = frame.gid.map(
        concentration(edges.groupby(["src", "dst"]).sum_kzt.sum())).fillna(0.)
    frame = frame.merge(temporal_features(tx), left_on="gid", right_index=True, how="left")
    for column in ["same_day_overlap", "active_days", "both_direction_days"]:
        frame[column] = frame[column].fillna(0)
    frame["same_day_ratio"] = np.where(
        frame.in_kzt > 0, np.minimum(frame.same_day_overlap / frame.in_kzt, 1.), 0.)
    maximum_flow = frame[["in_kzt", "out_kzt"]].max(axis=1).replace(0, np.nan)
    frame["flow_balance"] = (frame[["in_kzt", "out_kzt"]].min(axis=1) / maximum_flow).fillna(0.)

    neighbor_clusters = {node: set() for node in graph}
    for source, target in graph.edges:
        if cluster_map[source] != cluster_map[target]:
            neighbor_clusters[source].add(cluster_map[target])
            neighbor_clusters[target].add(cluster_map[source])
    frame["cross_cluster_count"] = frame.gid.map(lambda gid: len(neighbor_clusters[int(gid)])).astype(int)
    return frame


def score_roles(frame):
    pcols = ["in_deg", "out_deg", "in_kzt", "out_kzt", "in_tx", "out_tx", "pagerank",
             "betweenness", "upstream_seed_count", "cross_cluster_count", "active_days"]
    for column in pcols:
        frame[column + "_pct"] = percentile(frame[column])
    low_activity = 1 - np.maximum(frame.in_tx_pct, frame.out_tx_pct)
    has_in, has_out = (frame.in_deg > 0).astype(float), (frame.out_deg > 0).astype(float)
    both = has_in * has_out
    scores = pd.DataFrame(index=frame.index)
    scores["consolidator"] = (
        .29*frame.in_deg_pct + .20*frame.in_kzt_pct + .16*frame.in_tx_pct +
        .12*(1-frame.out_deg_pct) + .13*frame.upstream_seed_count_pct + .10*frame.pagerank_pct
    ) * ((frame.in_deg >= 3) & ~frame.is_seed)
    scores["distributor"] = (
        .31*frame.out_deg_pct + .22*frame.out_kzt_pct + .17*frame.out_tx_pct +
        .10*(1-frame.out_concentration) + .10*frame.betweenness_pct + .10*frame.upstream_seed_count_pct
    ) * (frame.out_deg >= 3)
    scores["transit"] = (
        .30*frame.same_day_ratio + .24*frame.flow_balance +
        .15*frame.both_direction_days.clip(upper=3)/3 + .13*frame.betweenness_pct +
        .10*frame.active_days_pct + .08*(1-np.abs(frame.in_deg_pct-frame.out_deg_pct))
    ) * both * (~frame.is_seed)
    observed = (frame.out_deg == 0) & (frame.in_deg > 0) & ~frame.truncated_by_depth
    censored = frame.truncated_by_depth & (frame.in_deg > 0)
    materiality = .38*frame.in_kzt_pct + .28*frame.in_tx_pct + .20*frame.in_deg_pct + .14*frame.active_days_pct
    scores["terminal"] = np.where(observed, .48+.52*materiality,
                                  np.where(censored, .20+.45*materiality, 0.))
    scores["coordinator"] = (
        .27*frame.betweenness_pct + .23*frame.upstream_seed_count_pct +
        .18*frame.cross_cluster_count_pct + .12*frame.pagerank_pct +
        .10*frame.in_deg_pct + .10*frame.out_deg_pct + .08*frame.is_articulation.astype(float)
    ).clip(upper=1.) * both * (
        (frame.upstream_seed_count >= 2) | frame.is_articulation | (frame.cross_cluster_count >= 2))
    scores["peripheral"] = (.30 + .55*low_activity + .15*(frame.in_deg+frame.out_deg <= 1)).clip(upper=1.)
    for role in ROLES:
        frame["score_" + role] = scores[role].fillna(0.).clip(0., 1.)
    role_columns = ["score_" + role for role in ROLES]
    frame["role"] = frame[role_columns].idxmax(axis=1).str.removeprefix("score_")
    frame["role_score"] = frame[role_columns].max(axis=1)
    isolates = (frame.in_deg == 0) & (frame.out_deg == 0)
    frame.loc[isolates, ["role", "role_score"]] = ["peripheral", 1.]

    activity = np.maximum.reduce([frame.in_kzt_pct, frame.out_kzt_pct, frame.in_tx_pct, frame.out_tx_pct])
    structural = np.maximum.reduce([frame.betweenness_pct, frame.pagerank_pct, frame.upstream_seed_count_pct])
    temporal_risk = np.maximum(frame.same_day_ratio, frame.in_cycle.astype(float)*.65)
    frame["priority_raw"] = (
        .24*frame.role.map(ROLE_RISK) + .14*frame.role_score + .22*activity +
        .20*structural + .10*temporal_risk + .10*frame.observability)
    frame.loc[isolates, "priority_raw"] = 0.
    frame["priority_score"] = percentile(frame.priority_raw)
    frame.loc[isolates, 'priority_score'] = 0.0
    return frame


def money(value):
    if value >= 1_000_000:
        return f"{value/1_000_000:.2f} млн"
    if value >= 1_000:
        return f"{value/1_000:.1f} тыс."
    return f"{value:.0f}"


def evidence_for(row):
    if row.in_deg == 0 and row.out_deg == 0:
        return "Изолированный узел: 0 входящих и 0 исходящих рёбер в наблюдаемом графе."
    if row.role == "consolidator":
        text = (f"Признаки сбора: {row.in_deg} плательщ., {row.in_tx} tx, {money(row.in_kzt)} KZT; "
                f"выход: {row.out_deg} получ., {money(row.out_kzt)} KZT; seed-ветвей {row.upstream_seed_count}.")
    elif row.role == "distributor":
        text = (f"Признаки распределения: {row.out_deg} получ., {row.out_tx} tx, {money(row.out_kzt)} KZT; "
                f"вход: {row.in_deg} плательщ., {money(row.in_kzt)} KZT.")
    elif row.role == "transit":
        text = (f"Признаки транзита: вход {money(row.in_kzt)}, выход {money(row.out_kzt)} KZT; "
                f"совпадение в тот же день {row.same_day_ratio:.0%}, двусторонних дней {int(row.both_direction_days)}.")
    elif row.role == "coordinator":
        text = (f"Связующий профиль: seed-ветвей {row.upstream_seed_count}, соседних кластеров {row.cross_cluster_count}; "
                f"плательщ./получ. {row.in_deg}/{row.out_deg}, посредничество: перцентиль {row.betweenness_pct:.0%}.")
    elif row.role == "terminal":
        note = "depth=4: исходящие неизвестны" if row.truncated_by_depth else "исходящих рёбер 0 в выборке"
        text = f"Получатель-кандидат: {row.in_deg} плательщ., {row.in_tx} tx, {money(row.in_kzt)} KZT; {note}."
    else:
        note = "depth=4, исходящие неизвестны" if row.truncated_by_depth else "выраженной структурной роли нет"
        text = f"Периферийный профиль: in/out degree {row.in_deg}/{row.out_deg}, оборот {money(row.in_kzt+row.out_kzt)} KZT; {note}."
    if row.truncated_by_depth and row.role not in {"terminal", "peripheral"}:
        text += " depth=4: исходящие неизвестны."
    return text[:200]


def cluster_hypothesis(group):
    counts = group.role.value_counts()
    if len(group) == 1 and group.iloc[0].in_deg + group.iloc[0].out_deg == 0:
        return "Изолированный клиент без наблюдаемых переводов"
    label = {"consolidator": "контур сбора", "distributor": "контур распределения",
             "transit": "транзитная цепочка", "terminal": "группа конечных получателей",
             "coordinator": "связующий контур", "peripheral": "периферийная группа"}[counts.index[0]]
    leaders = counts.index[:2]
    return f"{label}; ведущие роли: " + ", ".join(f"{role}={int(counts[role])}" for role in leaders)


def export_clusters(frame, edges):
    rows = []
    for cid, group in frame.groupby("cluster_id", sort=True):
        gids = set(group.gid)
        internal = edges[edges.src.isin(gids) & edges.dst.isin(gids)].sum_kzt.sum()
        leaders = group.sort_values(["priority_score", "gid"], ascending=[False, True]).head(5)
        rows.append({"cluster_id": int(cid), "n_nodes": len(group), "n_seed": int(group.is_seed.sum()),
                     "sum_kzt_internal": round(float(internal), 2),
                     "top_gids": ";".join(str(int(gid)) for gid in leaders.gid),
                     "hypothesis": cluster_hypothesis(group)})
    return pd.DataFrame(rows)


def export_graph_data(frame, edges, path, limit):
    ranked = frame.sort_values(["priority_score", "gid"], ascending=[False, True])
    # Keep every node and edge available to the UI so an arbitrary GID named by
    # the jury can be opened with its links. The browser renders only a small
    # ego-network at a time, so the complete payload remains responsive.
    selected = ranked if limit <= 0 else ranked.head(limit)
    selected_ids = set(map(int, selected.gid))
    selected_edges = edges[edges.src.isin(selected_ids) & edges.dst.isin(selected_ids)]
    colors = {"consolidator": "#ef4444", "transit": "#f59e0b", "distributor": "#3b82f6",
              "terminal": "#8b5cf6", "coordinator": "#10b981", "peripheral": "#64748b"}
    graph_nodes = []
    for row in selected.itertuples(index=False):
        graph_nodes.append({"id": str(int(row.gid)), "label": str(int(row.gid))[-6:],
            "gid": str(int(row.gid)), "role": row.role, "cluster_id": int(row.cluster_id),
            "priority_score": round(float(row.priority_score), 4), "role_score": round(float(row.role_score), 4),
            "in_kzt": round(float(row.in_kzt), 2), "out_kzt": round(float(row.out_kzt), 2),
            "in_deg": int(row.in_deg), "out_deg": int(row.out_deg), "depth": int(row.depth),
            "is_seed": bool(row.is_seed), "truncated": bool(row.truncated_by_depth),
            "evidence": row.evidence, "color": colors[row.role],
            "value": 8+24*float(row.priority_score),
            "title": f"GID {int(row.gid)}<br>{row.role}<br>priority {row.priority_score:.3f}"})
    max_amount = edges.sum_kzt.max()
    graph_edges = [{"from": str(int(row.src)), "to": str(int(row.dst)),
                    "sum_kzt": round(float(row.sum_kzt), 2), "n_tx": int(row.n_tx),
                    "width": round(1+3*math.log1p(float(row.sum_kzt))/math.log1p(max_amount), 2),
                    "title": f"{row.sum_kzt:,.0f} KZT · {int(row.n_tx)} tx"}
                   for row in selected_edges.itertuples(index=False)]
    payload = {"meta": {"total_nodes": len(frame), "shown_nodes": len(graph_nodes),
                         "shown_edges": len(graph_edges)}, "nodes": graph_nodes, "edges": graph_edges}
    path.write_text("window.graphData = "+json.dumps(payload, ensure_ascii=False, allow_nan=False)+";\n",
                    encoding="utf-8")


def write_outputs(frame, edges, out_dir, top_count, ui_limit):
    out_dir.mkdir(parents=True, exist_ok=True)
    frame = frame.copy()
    frame["evidence"] = frame.apply(evidence_for, axis=1)
    required = ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"]
    useful = ["in_deg", "out_deg", "in_kzt", "out_kzt", "in_tx", "out_tx", "pagerank",
              "pass_through", "depth", "is_seed", "truncated_by_depth", "observability",
              "upstream_seed_count", "betweenness", "same_day_ratio", "in_cycle",
              "cross_cluster_count", "is_articulation", "both_direction_days", "active_days",
              "flow_balance", "priority_raw"] + ['score_' + role for role in ROLES]
    frame[required+useful].to_csv(out_dir/"nodes_roles.csv", index=False, encoding="utf-8-sig")
    clusters = export_clusters(frame, edges)
    clusters.to_csv(out_dir/"clusters.csv", index=False, encoding="utf-8-sig")
    top = frame.sort_values(["priority_score", "gid"], ascending=[False, True]).head(max(20, top_count))
    top_export = pd.DataFrame({"rank": range(1, len(top)+1), "gid": top.gid.to_numpy(),
        "role": top.role.to_numpy(), "priority_score": top.priority_score.to_numpy(),
        "why": top.evidence.to_numpy()})
    top_export.to_csv(out_dir/"top_nodes.csv", index=False, encoding="utf-8-sig")
    export_graph_data(frame, edges, out_dir/"graph_data.js", ui_limit)
    counts = frame.role.value_counts().reindex(ROLES, fill_value=0)
    print("Roles:", ", ".join(f"{r}={c}" for r, c in counts.items()))
    print(f"Clusters: {len(clusters)}; top_nodes: {len(top_export)}")
    print(f"Outputs written to {out_dir.resolve()}")


def main():
    parser = argparse.ArgumentParser(description="Freedom AML graph analysis")
    parser.add_argument("--data", default="./data")
    parser.add_argument("--out", default="./out")
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--ui-limit", type=int, default=0,
                        help="0 = все узлы доступны в UI (рекомендуется)")
    args = parser.parse_args()
    edges, nodes, tx = load(Path(args.data))
    sanity_check(edges, nodes, tx)
    graph = build_graph(edges, nodes)
    frame = score_roles(compute_features(graph, edges, nodes, tx))
    write_outputs(frame, edges, Path(args.out), args.top, args.ui_limit)


if __name__ == "__main__":
    main()
