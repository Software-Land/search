"""Emit search-v2-relationships v1. No vectors."""

from __future__ import annotations

from typing import Any


def to_artifact(
    neighbors: dict[str, list[tuple[str, float]]],
    *,
    provenance: str,
    rel_type: str = "semantic",
) -> dict[str, Any]:
    relationships = {}
    for src, rows in sorted(neighbors.items()):
        if not rows:
            continue
        relationships[src] = [
            {
                "target": tgt,
                "type": rel_type,
                "strength": round(float(strength), 6),
                "provenance": provenance,
            }
            for tgt, strength in rows
        ]
    return {
        "format": "search-v2-relationships",
        "version": 1,
        "relationships": relationships,
    }


def edge_count(artifact: dict) -> int:
    return sum(len(v) for v in (artifact.get("relationships") or {}).values())
