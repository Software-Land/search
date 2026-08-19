"""Cheap build-time precision gates. Not a second ranker."""

from __future__ import annotations

import re
from collections import defaultdict

from lib.prepare import tokenize

VS_RE = re.compile(r"\bvs\b", re.I)


def title_tokens(title: str) -> list[str]:
    return tokenize(title)


def shared_content(a: list[str], b: list[str]) -> set[str]:
    return {t for t in a if t in b and len(t) >= 4}


def prefix_false_friend(src_toks: list[str], tgt_toks: list[str]) -> bool:
    """IoT vs IO: a short title token is a strict prefix of the other title's token."""
    for a in src_toks:
        for b in tgt_toks:
            if a == b:
                continue
            short, long = (a, b) if len(a) <= len(b) else (b, a)
            if 1 <= len(short) <= 3 and 2 <= len(long) <= 5 and long.startswith(short):
                if not shared_content(src_toks, tgt_toks):
                    return True
    return False


def contrastive_false_friend(src_title: str, tgt_title: str, src_toks: list[str], tgt_toks: list[str]) -> bool:
    if not VS_RE.search(src_title) or not VS_RE.search(tgt_title):
        return False
    return not shared_content(src_toks, tgt_toks)


def lexical_compatible(src: dict, tgt: dict, min_tfidf: float, tfidf_score: float | None) -> bool:
    """
    Weak precision gate. Pass if any of:
      - shared content token (len>=4)
      - titles are not prefix-false-friends / contrastive-false-friends
      - tiny TF-IDF overlap (optional)
    Fail only on obvious lexical contradiction/noise, not on zero overlap
    (DevOps↔CI/CD has no shared tokens).
    """
    st = title_tokens(src["title"])
    tt = title_tokens(tgt["title"])
    if prefix_false_friend(st, tt):
        return False
    if contrastive_false_friend(src["title"], tgt["title"], st, tt):
        return False
    if tfidf_score is not None and tfidf_score > 0 and tfidf_score < min_tfidf and not shared_content(st, tt):
        # Very low lexical score is allowed; only reject if we already flagged above.
        return True
    return True


def apply_precision_gate(
    neighbors: dict[str, list[tuple[str, float]]],
    docs_by_id: dict[str, dict],
    tfidf_lookup: dict[tuple[str, str], float] | None = None,
) -> dict[str, list[tuple[str, float]]]:
    out: dict[str, list[tuple[str, float]]] = {}
    for src, rows in neighbors.items():
        src_doc = docs_by_id.get(src)
        kept = []
        for tgt, score in rows:
            tgt_doc = docs_by_id.get(tgt)
            if not src_doc or not tgt_doc:
                continue
            key = (src, tgt) if src < tgt else (tgt, src)
            tfidf = (tfidf_lookup or {}).get(key)
            if lexical_compatible(src_doc, tgt_doc, min_tfidf=0.02, tfidf_score=tfidf):
                kept.append((tgt, score))
        if kept:
            out[src] = kept
    return out


def apply_neighbor_filters(
    neighbors: dict[str, list[tuple[str, float]]],
    docs_by_id: dict[str, dict],
    *,
    precision_gate: bool,
    mutual: bool,
    tfidf_lookup: dict[tuple[str, str], float] | None = None,
) -> dict[str, list[tuple[str, float]]]:
    """Directed top-K output → optional precision gate → optional mutual filter."""
    out = neighbors
    if precision_gate:
        out = apply_precision_gate(out, docs_by_id, tfidf_lookup)
    if mutual:
        out = mutual_neighbors(out)
    return out


def mutual_neighbors(neighbors: dict[str, list[tuple[str, float]]]) -> dict[str, list[tuple[str, float]]]:
    sets = {src: {t for t, _ in rows} for src, rows in neighbors.items()}
    out: dict[str, list[tuple[str, float]]] = {}
    for src, rows in neighbors.items():
        kept = [(t, s) for t, s in rows if src in sets.get(t, set())]
        if kept:
            out[src] = kept
    return out


def adaptive_neighbors(
    pairs: list[tuple[str, str, float]],
    *,
    top_k: int,
    abs_min: float,
    relative: float,
) -> dict[str, list[tuple[str, float]]]:
    """Keep neighbors that are locally close to the source's best score, above abs_min."""
    buckets: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for a, b, s in pairs:
        buckets[a].append((b, s))
        buckets[b].append((a, s))
    out: dict[str, list[tuple[str, float]]] = {}
    for src, neigh in buckets.items():
        neigh.sort(key=lambda x: (-x[1], x[0]))
        if not neigh:
            continue
        best = neigh[0][1]
        floor = max(abs_min, relative * best)
        kept = [(t, s) for t, s in neigh if s >= floor][: max(0, top_k)]
        if kept:
            out[src] = kept
    return out


def classify_edge(src_title: str, tgt_title: str, gold: set[tuple[str, str]], negatives: dict[tuple[str, str], str]) -> str:
    key = (src_title, tgt_title)
    if key in gold:
        return "GOOD_TOPICAL_RELATIONSHIP"
    if key in negatives:
        return negatives[key]
    st = title_tokens(src_title)
    tt = title_tokens(tgt_title)
    if prefix_false_friend(st, tt):
        return "LEXICAL_FALSE_FRIEND"
    if contrastive_false_friend(src_title, tgt_title, st, tt):
        return "TITLE_CONTRAST_ARTIFACT"
    if src_title.lower().startswith("what is") and tgt_title.lower().startswith("what is"):
        return "OVERLY_BROAD_TOPIC"
    if not shared_content(st, tt):
        return "GENERIC_TECHNICAL_SIMILARITY"
    return "WEAK_BUT_VALID"
