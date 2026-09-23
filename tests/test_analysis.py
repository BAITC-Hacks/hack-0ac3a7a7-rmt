"""Numerical and artifact consistency checks for the analyst dossier."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from analysis_report import lagged_observations
from provenance import verify_manifest
from server import Snapshot, compile_dataset
from test_workspace import fixture


class AnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='aml-analysis-')
        cls.root=Path(cls.tmp.name)
        cls.ids=fixture(cls.root/'data')
        compile_dataset(cls.root/'data',cls.root/'out')
        cls.snap=Snapshot(cls.root/'data',cls.root/'out','audit','Audit')

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def test_role_explanations_match_export_exactly(self):
        for c in self.snap.nodes:
            a=self.snap.analysis['nodes'][c['gid']]
            self.assertEqual(a['winner'],c['role'])
            self.assertAlmostEqual(min(1,sum(t['contribution'] for t in a['terms'])),c['role_score'])
            self.assertAlmostEqual(a['winner_score']-a['runner_score'],a['margin'])
            self.assertAlmostEqual(sum(t['contribution'] for t in a['priority_terms']),c['priority_raw'])
            self.assertGreaterEqual(a['margin'],-1e-12)
            for r in a['roles']:
                self.assertAlmostEqual(r['score'],c['score_'+r['role']])
                if not r['eligible']: self.assertEqual(r['score'],0)

    def test_lag_does_not_reuse_incoming_or_outgoing(self):
        days=[{'date':'2026-07-01','incoming':100,'outgoing':100},
              {'date':'2026-07-02','incoming':100,'outgoing':70},
              {'date':'2026-07-03','incoming':0,'outgoing':100},
              {'date':'2026-07-05','incoming':0,'outgoing':100}]
        result=lagged_observations(days)
        self.assertEqual(result['matched_kzt'],170)
        self.assertEqual(result['ratio'],.85)
        self.assertEqual(result['total_windows'],3)
        self.assertEqual(lagged_observations(days[:1])['matched_kzt'],0)
        self.assertEqual(lagged_observations([])['ratio'],0)

    def test_lag_month_boundary_and_expiry(self):
        incoming={'date':'2026-07-31','incoming':100,'outgoing':0}
        outgoing={'date':'2026-08-02','incoming':0,'outgoing':200}
        self.assertEqual(lagged_observations([outgoing,incoming])['matched_kzt'],100)
        self.assertEqual(lagged_observations([incoming,{**outgoing,'date':'2026-08-03'}])['matched_kzt'],0)

    def test_seed_path_is_directed_shortest_and_complete(self):
        path=self.snap.seed_path(self.ids[4])
        self.assertEqual(path['nodes'],[self.ids[0],self.ids[2],self.ids[3],self.ids[4]])
        self.assertEqual([e['sum_kzt'] for e in path['edges']],[10000,20000,15000])
        self.assertEqual(self.snap.seed_path(self.ids[0])['edges'],[])
        self.assertEqual(self.snap.seed_path('999')['nodes'],[])

    def test_sensitivity_is_bounded_and_reproducible(self):
        audit=self.snap.analysis['stability']
        self.assertEqual(audit['runs'],12)
        self.assertEqual(audit['min_overlap'],5)
        for a in self.snap.analysis['nodes'].values():
            self.assertGreaterEqual(a['stability']['rank_min'],1)
            self.assertLessEqual(a['stability']['rank_max'],5)
        compile_dataset(self.root/'data',self.root/'repeat')
        for name in ('nodes_roles.csv','clusters.csv','top_nodes.csv','analysis.json'):
            self.assertEqual((self.root/'out'/name).read_bytes(),(self.root/'repeat'/name).read_bytes())

    def test_snapshot_downloads_are_immutable_and_manifest_detects_changes(self):
        original=self.snap.downloads['nodes_roles.csv']
        with patch('provenance.signature',return_value={'inputs':{},'outputs':{},'sources':{}}):
            with self.assertRaises(ValueError): verify_manifest(self.root/'data',self.root/'out')
        with patch.object(Path,'read_bytes',return_value=b'changed'):
            self.assertEqual(self.snap.downloads['nodes_roles.csv'],original)


if __name__=='__main__': unittest.main()
