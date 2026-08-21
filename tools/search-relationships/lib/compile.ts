import { ARTIFACT_FORMAT, EXPLICIT_STRENGTH, DEFAULT_RUNTIME_TYPES, isSymmetricType } from "./types.js";
import { stableSort } from "./hash.js";
import type { ResolvedDomainRelationship } from "./domain.js";
import type { RelationshipArtifact, RelationshipEdge } from "../types.js";

function emptyRelationships(): Record<string, RelationshipEdge[]> {
  return {};
}

function edgeProvenance(row: ResolvedDomainRelationship): string {
  return row.provenance || "manual";
}

function explicitStrength(row: ResolvedDomainRelationship): number {
  if (row.priority != null && Number.isFinite(row.priority)) {
    return Math.max(0, Math.min(1, row.priority));
  }
  return EXPLICIT_STRENGTH;
}

function pushEdge(bag: Map<string, RelationshipEdge[]>, source: string, edge: RelationshipEdge) {
  if (!bag.has(source)) bag.set(source, []);
  const list = bag.get(source) || [];
  if (list.some((e) => e.target === edge.target && e.type === edge.type)) return;
  list.push(edge);
}

export function compileDomain(resolved: readonly ResolvedDomainRelationship[]): RelationshipArtifact {
  const bag = new Map<string, RelationshipEdge[]>();
  for (const row of resolved) {
    const edge = {
      target: row.resolvedTarget,
      type: row.type,
      strength: explicitStrength(row),
      provenance: edgeProvenance(row),
    };
    pushEdge(bag, row.resolvedSource, edge);
    if (isSymmetricType(row.type, { directional: row.directional })) {
      pushEdge(bag, row.resolvedTarget, { ...edge, target: row.resolvedSource });
    }
  }
  return toArtifact(bag);
}

export function toArtifact(bag: Map<string, RelationshipEdge[]>): RelationshipArtifact {
  const relationships = emptyRelationships();
  const sources = stableSort([...bag.keys()], (k) => k);
  for (const source of sources) {
    relationships[source] = stableSort(bag.get(source) || [], (e) => `${e.type}:${e.target}`).sort((a, b) => {
      const s = (b.strength || 0) - (a.strength || 0);
      if (s) return s;
      return `${a.type}:${a.target}`.localeCompare(`${b.type}:${b.target}`);
    });
  }
  return {
    format: ARTIFACT_FORMAT,
    version: 1,
    relationships,
  };
}

function resolveFilterTypes(typesOrOpts?: unknown): readonly string[] {
  if (typesOrOpts == null) return DEFAULT_RUNTIME_TYPES;
  if (Array.isArray(typesOrOpts)) return typesOrOpts;
  if (typeof typesOrOpts === "object") {
    const fromOpts = "types" in typesOrOpts ? (typesOrOpts as { types?: readonly string[] }).types : undefined;
    return fromOpts ?? DEFAULT_RUNTIME_TYPES;
  }
  return DEFAULT_RUNTIME_TYPES;
}

/**
 * Public contract is `filterRelationships(artifact, types?: readonly string[])`.
 * Internal merge still passes `{ types }`.
 */
export function filterRelationships(
  artifact: RelationshipArtifact | null | undefined,
  typesOrOpts?: unknown
): RelationshipArtifact {
  const types = resolveFilterTypes(typesOrOpts);
  const allow = new Set(types);
  const relationships = emptyRelationships();
  for (const [source, edges] of Object.entries(artifact?.relationships || {})) {
    const kept = (edges || []).filter((e) => allow.has(e.type || ""));
    if (kept.length) relationships[source] = kept;
  }
  return { format: ARTIFACT_FORMAT, version: artifact?.version || 1, relationships };
}
