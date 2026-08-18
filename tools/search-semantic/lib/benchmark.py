"""Independent document→related-document benchmark. Not query relevance."""

from __future__ import annotations

from collections import defaultdict


def resolve_judgments(judgments: dict, title_to_id: dict[str, str]) -> list[dict]:
    resolved = []
    for pair in judgments.get("pairs") or []:
        src = title_to_id.get(pair["sourceTitle"])
        if not src:
            continue
        targets = [title_to_id[t] for t in pair.get("relatedTitles") or [] if t in title_to_id]
        if not targets:
            continue
        resolved.append(
            {
                "family": pair.get("family") or "unspecified",
                "sourceId": src,
                "sourceTitle": pair["sourceTitle"],
                "targetIds": targets,
                "targetTitles": [t for t in pair.get("relatedTitles") or [] if t in title_to_id],
            }
        )
    return resolved


def evaluate_graph(neighbors: dict[str, list[tuple[str, float]]], cases: list[dict], ks=(3, 5, 10)) -> dict:
    by_family = defaultdict(list)
    rec = {k: [] for k in ks}
    mrr = []
    examples = []
    for case in cases:
        ranked = [t for t, _ in neighbors.get(case["sourceId"], [])]
        gold = case["targetIds"]
        rr = 0.0
        for i, tid in enumerate(ranked, start=1):
            if tid in gold:
                rr = 1.0 / i
                break
        mrr.append(rr)
        for k in ks:
            hit = sum(1 for t in ranked[:k] if t in gold)
            rec[k].append(hit / max(1, len(gold)))
        by_family[case["family"]].append(rr)
        examples.append(
            {
                "sourceTitle": case["sourceTitle"],
                "family": case["family"],
                "gold": case["targetTitles"],
                "predicted": ranked[:5],
                "rr": rr,
            }
        )
    def mean(xs):
        return round(sum(xs) / len(xs), 4) if xs else None

    return {
        "n": len(cases),
        "mrr": mean(mrr),
        "recall": {f"@{k}": mean(rec[k]) for k in ks},
        "mrrByFamily": {fam: mean(xs) for fam, xs in sorted(by_family.items())},
        "examples": examples,
    }


def resolve_negatives(negatives: dict, title_to_id: dict[str, str]) -> list[dict]:
    out = []
    for pair in negatives.get("pairs") or []:
        src = title_to_id.get(pair["sourceTitle"])
        if not src:
            continue
        forbidden = [title_to_id[t] for t in pair.get("forbiddenTitles") or [] if t in title_to_id]
        if not forbidden:
            continue
        out.append(
            {
                "sourceId": src,
                "sourceTitle": pair["sourceTitle"],
                "forbiddenIds": forbidden,
                "forbiddenTitles": [t for t in pair.get("forbiddenTitles") or [] if t in title_to_id],
                "reason": pair.get("reason") or "undesirable",
            }
        )
    return out


def negative_violations(neighbors: dict[str, list[tuple[str, float]]], cases: list[dict]) -> dict:
    hits = []
    for case in cases:
        ranked = [t for t, _ in neighbors.get(case["sourceId"], [])]
        for tid, title in zip(case["forbiddenIds"], case["forbiddenTitles"]):
            if tid in ranked:
                hits.append(
                    {
                        "sourceTitle": case["sourceTitle"],
                        "forbiddenTitle": title,
                        "rank": ranked.index(tid) + 1,
                        "reason": case["reason"],
                    }
                )
    return {"count": len(hits), "hits": hits}


def sparsity(neighbors: dict[str, list[tuple[str, float]]], document_count: int) -> dict:
    counts = [len(neighbors.get(k, [])) for k in neighbors]
    all_counts = counts + [0] * max(0, document_count - len(neighbors))
    all_counts.sort()
    n = len(all_counts) or 1
    edges = sum(all_counts)
    return {
        "documents": document_count,
        "edges": edges,
        "meanEdgesPerDoc": round(edges / document_count, 3) if document_count else 0,
        "medianEdgesPerDoc": all_counts[n // 2] if all_counts else 0,
        "maxEdgesPerDoc": max(all_counts) if all_counts else 0,
        "emptyNeighborhoods": sum(1 for c in all_counts if c == 0),
    }
