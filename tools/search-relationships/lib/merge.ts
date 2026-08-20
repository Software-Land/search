/**
 * Deterministic merge of relationship artifacts.
 * Human reject of a pair/type wins. Multiple types between the same
 * documents are preserved as separate edges.
 */

import { ALLOWED_TYPES, DEFAULT_RUNTIME_TYPES } from "./types.js";
import { relationshipId, pairKey } from "./ids.js";
import { toArtifact, filterRelationships } from "./compile.js";
import type { FlattenedEdge, MergeRelOptions, RelLifecycleResult, RelationshipEdge } from "../types.js";

function flatten(artifact: unknown, fallbackType = "semantic"): FlattenedEdge[] {
  const out: FlattenedEdge[] = [];
  if (!artifact || typeof artifact !== "object") return out;
  const rec = artifact as {
    relationships?: Record<string, Array<{ target?: unknown; type?: unknown; strength?: unknown; provenance?: unknown }> | undefined>;
  };
  for (const [source, edges] of Object.entries(rec.relationships || {})) {
    for (const e of edges || []) {
      if (!e?.target) continue;
      out.push({
        source: String(source),
        target: String(e.target),
        type: String(e.type || fallbackType),
        strength: e.strength == null ? null : Number(e.strength),
        provenance: e.provenance ? String(e.provenance) : null,
      });
    }
  }
  return out;
}

function rejected(life: Partial<RelLifecycleResult>, source: string, target: string, type: string): boolean {
  if (life.rejectAllPairs?.has(pairKey(source, target)) || life.rejectAllPairs?.has(pairKey(target, source))) {
    return true;
  }
  const directionalId = relationshipId(type, source, target, { directional: true });
  const symmetricId = relationshipId(type, source, target, { directional: false });
  if (life.rejectedIds?.has(directionalId) || life.rejectedIds?.has(symmetricId)) return true;
  for (const c of life.candidates || []) {
    if (c.lifecycle !== "HUMAN_REJECTED" && c.lifecycle !== "ORPHANED_DECISION") continue;
    if (c.type !== "*") continue;
    const a = c.resolvedSource || c.source;
    const b = c.resolvedTarget || c.target;
    if ((a === source && b === target) || (a === target && b === source)) return true;
  }
  return false;
}

export function mergeRelationshipArtifacts({
  semantic = null,
  domain = null,
  life = {},
  runtimeTypes = DEFAULT_RUNTIME_TYPES,
}: MergeRelOptions = {}): { full: ReturnType<typeof toArtifact>; runtime: ReturnType<typeof filterRelationships> } {
  const bag = new Map<string, RelationshipEdge[]>();
  const keyOf = (s: string, t: string, type: string) => `${s}::${t}::${type}`;
  const seen = new Map<string, FlattenedEdge>();

  function add(edge: FlattenedEdge) {
    if (!ALLOWED_TYPES.has(edge.type)) return;
    if (edge.source === edge.target) return;
    if (rejected(life, edge.source, edge.target, edge.type)) return;
    const k = keyOf(edge.source, edge.target, edge.type);
    const prev = seen.get(k);
    if (prev) {
      const takeNew = (edge.strength || 0) > (prev.strength || 0);
      const kept = takeNew ? { ...edge } : { ...prev };
      const provenances = [...new Set([prev.provenance, edge.provenance].filter(Boolean))];
      kept.provenance = provenances.join("+");
      seen.set(k, kept);
      return;
    }
    seen.set(k, { ...edge });
  }

  for (const e of flatten(semantic, "semantic")) add(e);
  for (const e of flatten(domain, "editorial")) add(e);

  for (const edge of seen.values()) {
    if (!bag.has(edge.source)) bag.set(edge.source, []);
    (bag.get(edge.source) || []).push({
      target: edge.target,
      type: edge.type,
      strength: edge.strength == null ? 1 : edge.strength,
      provenance: edge.provenance,
    });
  }

  const full = toArtifact(bag);
  const runtime = filterRelationships(full, { types: runtimeTypes });
  return { full, runtime };
}
