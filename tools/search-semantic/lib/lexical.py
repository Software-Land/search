"""Build-time TF-IDF cosine document similarity. No neural dependencies."""

from __future__ import annotations

import math
from collections import Counter, defaultdict


def _idf(docs: list[list[str]]) -> dict[str, float]:
    df: dict[str, int] = defaultdict(int)
    n = max(1, len(docs))
    for toks in docs:
        for t in set(toks):
            df[t] += 1
    return {t: math.log((1 + n) / (1 + c)) + 1.0 for t, c in df.items()}


def _tfidf(tokens: list[str], idf: dict[str, float]) -> dict[str, float]:
    tf = Counter(tokens)
    n = max(1, len(tokens))
    vec = {t: (c / n) * idf.get(t, 0.0) for t, c in tf.items()}
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    return {t: v / norm for t, v in vec.items()}


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return float(sum(v * b.get(k, 0.0) for k, v in a.items()))


def pairwise_lexical(prepared: list[dict]) -> list[tuple[str, str, float]]:
    """Return unique undirected pairs (id_i, id_j, cosine) with i < j."""
    idf = _idf([p["tokens"] for p in prepared])
    vecs = [_tfidf(p["tokens"], idf) for p in prepared]
    ids = [p["id"] for p in prepared]
    pairs = []
    n = len(prepared)
    for i in range(n):
        for j in range(i + 1, n):
            s = cosine(vecs[i], vecs[j])
            if s > 0:
                pairs.append((ids[i], ids[j], s))
    return pairs
