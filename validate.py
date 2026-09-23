#!/usr/bin/env python3
"""Mechanical validation of the hackathon deliverables."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
DATA = ROOT / "data"
ROLES = {"consolidator", "transit", "distributor", "terminal", "coordinator", "peripheral"}


def main() -> None:
    nodes = pd.read_parquet(DATA / "nodes.parquet")
    edges = pd.read_parquet(DATA / "edges.parquet")
    roles = pd.read_csv(OUT / "nodes_roles.csv")
    clusters = pd.read_csv(OUT / "clusters.csv")
    top = pd.read_csv(OUT / "top_nodes.csv")

    assert list(roles.columns[:6]) == [
        "gid", "role", "role_score", "cluster_id", "priority_score", "evidence"
    ]
    assert list(clusters.columns) == [
        "cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"
    ]
    assert list(top.columns) == ["rank", "gid", "role", "priority_score", "why"]
    assert len(roles) == 2_248 == roles.gid.nunique()
    assert set(roles.gid) == set(nodes.gid)
    assert not roles.isna().any().any()
    assert not clusters.isna().any().any()
    assert not top.isna().any().any()
    assert set(roles.role) == ROLES
    assert roles.role_score.between(0, 1).all()
    assert roles.priority_score.between(0, 1).all()
    assert roles.evidence.map(lambda value: bool(re.search(r"\d", value)) and len(value) <= 200).all()
    assert len(clusters) == roles.cluster_id.nunique()
    assert set(clusters.cluster_id) == set(roles.cluster_id)
    assert len(top) >= 20 and top.priority_score.is_monotonic_decreasing
    assert top["rank"].tolist() == list(range(1, len(top) + 1))

    cluster_by_gid = roles.set_index("gid").cluster_id
    internal = edges.assign(
        source_cluster=edges.src.map(cluster_by_gid),
        target_cluster=edges.dst.map(cluster_by_gid),
    )
    internal = internal[internal.source_cluster == internal.target_cluster]
    calculated = internal.groupby("source_cluster").sum_kzt.sum()
    reported = clusters.set_index("cluster_id").sum_kzt_internal
    assert all(abs(reported.get(cluster_id, 0) - amount) < 0.01 for cluster_id, amount in calculated.items())

    raw = (OUT / "graph_data.js").read_text(encoding="utf-8")
    payload = json.loads(raw.removeprefix("window.graphData = ").removesuffix(";\n"))
    assert len(payload["nodes"]) == len(nodes)
    assert len(payload["edges"]) == len(edges)
    assert {int(item["id"]) for item in payload["nodes"]} == set(nodes.gid)
    assert all(isinstance(item["id"], str) for item in payload["nodes"])

    print(
        f"Output validation: OK - {len(roles)} nodes, "
        f"{len(clusters)} clusters, top-{len(top)}, {len(edges)} UI edges"
    )


if __name__ == "__main__":
    main()
