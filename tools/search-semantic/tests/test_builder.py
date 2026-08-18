import json
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.artifact import to_artifact
from lib.benchmark import evaluate_graph, resolve_judgments
from lib.lexical import pairwise_lexical
from lib.neighbors import directed_neighbors, rrf_fuse
from lib.prepare import prepared_documents
from lib.filters import mutual_neighbors, prefix_false_friend, title_tokens


DOCS = [
    {"id": "/tls/", "title": "TLS 1.2 Vulnerability", "body": "transport layer security certificates https encryption"},
    {"id": "/vpn/", "title": "What is VPN?", "body": "virtual private network tunnels encrypted traffic tls"},
    {"id": "/recursion/", "title": "What is Recursion?", "body": "a function calls itself until a base case"},
    {"id": "/noise/", "title": "About this Blog", "body": "welcome to the site navigation footer"},
]


class BuilderTests(unittest.TestCase):
    def test_tfidf_prefers_topical_neighbors_over_noise(self):
        prepared = prepared_documents(DOCS, "title_lead")
        pairs = pairwise_lexical(prepared)
        graph = directed_neighbors(pairs, top_k=2, min_score=0.05)
        nids = [t for t, _ in graph.get("/tls/", [])]
        self.assertIn("/vpn/", nids)
        self.assertNotIn("/tls/", nids)

    def test_threshold_can_emit_empty_lists(self):
        prepared = prepared_documents(DOCS, "title")
        pairs = pairwise_lexical(prepared)
        graph = directed_neighbors(pairs, top_k=5, min_score=0.99)
        self.assertEqual(graph.get("/noise/", []), [])

    def test_artifact_has_no_vectors(self):
        art = to_artifact({"/tls/": [("/vpn/", 0.81)]}, provenance="lexical")
        self.assertEqual(art["format"], "search-v2-relationships")
        blob = json.dumps(art)
        self.assertNotIn("embedding", blob)
        self.assertNotIn("vector", blob)
        self.assertEqual(art["relationships"]["/tls/"][0]["type"], "semantic")
        self.assertEqual(art["relationships"]["/tls/"][0]["provenance"], "lexical")

    def test_rrf_keeps_original_strength(self):
        a = {"/tls/": [("/vpn/", 0.4), ("/recursion/", 0.2)]}
        b = {"/tls/": [("/vpn/", 0.9)]}
        fused = rrf_fuse([a, b], top_k=2)
        self.assertEqual(fused["/tls/"][0][0], "/vpn/")
        self.assertAlmostEqual(fused["/tls/"][0][1], 0.9)

    def test_benchmark_is_document_to_document(self):
        judgments = {
            "pairs": [{"family": "sec", "sourceTitle": "TLS 1.2 Vulnerability", "relatedTitles": ["What is VPN?"]}]
        }
        title_to_id = {d["title"]: d["id"] for d in DOCS}
        cases = resolve_judgments(judgments, title_to_id)
        graph = {"/tls/": [("/vpn/", 0.8)]}
        out = evaluate_graph(graph, cases, ks=(1, 3))
        self.assertEqual(out["recall"]["@1"], 1.0)
        self.assertEqual(out["mrr"], 1.0)

    def test_iot_io_is_a_prefix_false_friend(self):
        self.assertTrue(prefix_false_friend(title_tokens("What is IoT?"), title_tokens("What is IO?")))
        self.assertFalse(prefix_false_friend(title_tokens("gRPC vs Kafka"), title_tokens("gRPC vs REST")))

    def test_mutual_requires_both_directions(self):
        g = {"a": [("b", 0.9), ("c", 0.8)], "b": [("c", 0.7)], "c": [("a", 0.6)]}
        mut = mutual_neighbors(g)
        self.assertEqual([t for t, _ in mut.get("a", [])], ["c"])
        self.assertEqual(mut.get("b"), None)


if __name__ == "__main__":
    unittest.main()
