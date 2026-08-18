"""Neighbor selection: directed top-K with a minimum score. Empty lists are allowed."""

from __future__ import annotations

from collections import defaultdict


def directed_neighbors(
    pairs: list[tuple[str, str, float]],
    *,
    top_k: int,
    min_score: float,
) -> dict[str, list[tuple[str, float]]]:
    """
    Cosine is symmetric, top-K is not. We keep directed lists:
    A may include B while B omits A. Better than forcing junk neighbors.
    """
    buckets: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for a, b, s in pairs:
        if s < min_score:
            continue
        buckets[a].append((b, s))
        buckets[b].append((a, s))
    out: dict[str, list[tuple[str, float]]] = {}
    for src, neigh in buckets.items():
        neigh.sort(key=lambda x: (-x[1], x[0]))
        trimmed = neigh[: max(0, top_k)]
        out[src] = trimmed
    return out


def rrf_fuse(
    graphs: list[dict[str, list[tuple[str, float]]]],
    *,
    top_k: int,
    k: int = 60,
) -> dict[str, list[tuple[str, float]]]:
    """
    Reciprocal rank fusion of directed neighbor lists.
    Ranking uses RRF; stored strength is the max original similarity so the
    runtime artifact stays on a 0–1-ish scale without mixing raw TF-IDF and cosine.
    """
    sources = set()
    for g in graphs:
        sources.update(g)
    fused: dict[str, list[tuple[str, float]]] = {}
    for src in sources:
        rrf: dict[str, float] = defaultdict(float)
        best: dict[str, float] = {}
        for g in graphs:
            for rank, (tgt, score) in enumerate(g.get(src, []), start=1):
                rrf[tgt] += 1.0 / (k + rank)
                prev = best.get(tgt)
                if prev is None or score > prev:
                    best[tgt] = float(score)
        ranked = sorted(rrf.items(), key=lambda x: (-x[1], x[0]))[: max(0, top_k)]
        fused[src] = [(t, best.get(t, 0.0)) for t, _ in ranked]
    return fused
