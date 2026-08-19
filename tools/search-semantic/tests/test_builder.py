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
from lib.filters import (
    apply_neighbor_filters,
    apply_precision_gate,
    contrastive_false_friend,
    mutual_neighbors,
    prefix_false_friend,
    title_tokens,
)


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

    def test_contrastive_vs_pairs_need_shared_content_token(self):
        self.assertTrue(
            contrastive_false_friend(
                "Symmetric vs Asymmetric Encryption",
                "Asynchronous vs Synchronous",
                title_tokens("Symmetric vs Asymmetric Encryption"),
                title_tokens("Asynchronous vs Synchronous"),
            )
        )
        self.assertFalse(
            contrastive_false_friend(
                "gRPC vs Kafka",
                "gRPC vs REST",
                title_tokens("gRPC vs Kafka"),
                title_tokens("gRPC vs REST"),
            )
        )

    def test_precision_gate_drops_prefix_and_contrastive_false_friends(self):
        docs = {
            "iot": {"id": "iot", "title": "What is IoT?"},
            "io": {"id": "io", "title": "What is IO?"},
            "edge": {"id": "edge", "title": "Edge Computing"},
            "sym": {"id": "sym", "title": "Symmetric vs Asymmetric Encryption"},
            "async": {"id": "async", "title": "Asynchronous vs Synchronous"},
            "grpc": {"id": "grpc", "title": "gRPC vs Kafka"},
            "rest": {"id": "rest", "title": "gRPC vs REST"},
            "devops": {"id": "devops", "title": "What is DevOps?"},
            "cicd": {"id": "cicd", "title": "CI/CD"},
        }
        neighbors = {
            "iot": [("io", 0.9), ("edge", 0.4)],
            "io": [("iot", 0.9)],
            "sym": [("async", 0.8)],
            "grpc": [("rest", 0.7)],
            "devops": [("cicd", 0.5)],
        }
        gated = apply_precision_gate(neighbors, docs)
        self.assertEqual([t for t, _ in gated.get("iot", [])], ["edge"])
        self.assertIsNone(gated.get("io"))
        self.assertIsNone(gated.get("sym"))
        self.assertEqual([t for t, _ in gated.get("grpc", [])], ["rest"])
        self.assertEqual([t for t, _ in gated.get("devops", [])], ["cicd"])

    def test_neighbor_filters_gate_then_mutual(self):
        docs = {
            "a": {"id": "a", "title": "What is IoT?"},
            "b": {"id": "b", "title": "What is IO?"},
            "c": {"id": "c", "title": "Edge Computing"},
        }
        neighbors = {"a": [("b", 0.9), ("c", 0.4)], "b": [("a", 0.9)], "c": [("a", 0.4)]}
        out = apply_neighbor_filters(neighbors, docs, precision_gate=True, mutual=True)
        self.assertEqual([t for t, _ in out.get("a", [])], ["c"])
        self.assertEqual([t for t, _ in out.get("c", [])], ["a"])
        self.assertIsNone(out.get("b"))


if __name__ == "__main__":
    unittest.main()
