#!/usr/bin/env python3
"""
Offline relationship compiler.

  python tools/search-semantic/build.py \
    --input corpus.json \
    --method embedding \
    --top-k 5 \
    --min-score 0.3 \
    --output relationships.json

Does not import Search Core. Emits search-v2-relationships v1 only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lib.artifact import edge_count, to_artifact
from lib.embedding import DEFAULT_MODEL, load_or_embed, pairwise_embedding
from lib.lexical import pairwise_lexical
from lib.neighbors import directed_neighbors, rrf_fuse
from lib.prepare import prepared_documents


def load_corpus(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    return data.get("documents") or []


def timed(fn):
    t0 = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - t0


def build(args) -> dict:
    docs = load_corpus(Path(args.input))
    prepared, prep_s = timed(lambda: prepared_documents(docs, args.representation))
    ids = [p["id"] for p in prepared]
    report = {
        "documentCount": len(docs),
        "representation": args.representation,
        "method": args.method,
        "topK": args.top_k,
        "minScore": args.min_score,
        "directionality": "directed-topk",
        "timings": {"prepareSec": round(prep_s, 4)},
    }

    lex_pairs = emb_pairs = None
    if args.method in ("lexical", "combined"):
        lex_pairs, sec = timed(lambda: pairwise_lexical(prepared))
        report["timings"]["lexicalPairwiseSec"] = round(sec, 4)
        report["lexicalPairCount"] = len(lex_pairs)

    if args.method in ("embedding", "combined"):
        cache = Path(args.cache_dir)
        vecs, meta = None, None

        def embed():
            nonlocal vecs, meta
            vecs, meta = load_or_embed(prepared, model_name=args.model, cache_dir=cache)
            return pairwise_embedding(ids, vecs)

        emb_pairs, sec = timed(embed)
        report["timings"]["embeddingSec"] = round(sec, 4)
        report["embedding"] = meta
        report["embeddingPairCount"] = len(emb_pairs)

    lex_floor = args.lexical_min_score if args.lexical_min_score is not None else args.min_score
    emb_floor = args.embedding_min_score if args.embedding_min_score is not None else args.min_score

    if args.method == "lexical":
        neighbors = directed_neighbors(lex_pairs, top_k=args.top_k, min_score=lex_floor)
        provenance = "lexical"
        report["appliedMinScore"] = lex_floor
    elif args.method == "embedding":
        neighbors = directed_neighbors(emb_pairs, top_k=args.top_k, min_score=emb_floor)
        provenance = "embedding"
        report["appliedMinScore"] = emb_floor
    elif args.method == "combined":
        # TF-IDF cosine and embedding cosine are not on the same scale.
        # Fuse ranks, not raw scores. Empty lists remain allowed after top-K.
        g_lex = directed_neighbors(lex_pairs, top_k=max(args.top_k, 10), min_score=lex_floor)
        g_emb = directed_neighbors(emb_pairs, top_k=max(args.top_k, 10), min_score=emb_floor)
        neighbors = rrf_fuse([g_lex, g_emb], top_k=args.top_k)
        provenance = "combined"
        report["fusion"] = "reciprocal-rank-fusion k=60; stored strength = max(lexical, embedding)"
        report["lexicalMinScore"] = lex_floor
        report["embeddingMinScore"] = emb_floor
    else:
        raise SystemExit(f"unknown method {args.method}")

    artifact = to_artifact(neighbors, provenance=provenance)
    report["edgeCount"] = edge_count(artifact)
    report["sourceCount"] = len(artifact["relationships"])
    return artifact, report, prepared, neighbors


def main():
    p = argparse.ArgumentParser(description="Compile search-v2-relationships v1")
    p.add_argument("--input", required=True, help="JSON list or {documents:[...]}")
    p.add_argument("--output", required=True)
    p.add_argument("--method", choices=["lexical", "embedding", "combined"], default="lexical")
    p.add_argument(
        "--representation",
        choices=["title", "title_lead", "title_struct", "title_once_lead", "title_headings", "title_body", "title_full"],
        default="title_lead",
    )
    p.add_argument("--top-k", type=int, default=5)
    p.add_argument("--min-score", type=float, default=0.25)
    p.add_argument("--lexical-min-score", type=float, default=None)
    p.add_argument("--embedding-min-score", type=float, default=None)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--cache-dir", default=str(ROOT / ".cache" / "embeddings"))
    p.add_argument("--report", default="")
    args = p.parse_args()

    artifact, report, _, _ = build(args)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    report["output"] = str(out)
    report["artifactBytes"] = out.stat().st_size
    if args.report:
        rp = Path(args.report)
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("method", "representation", "edgeCount", "sourceCount", "artifactBytes", "timings") if k in report}, indent=2))


if __name__ == "__main__":
    main()
