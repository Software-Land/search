import { ARTIFACT_FORMAT, EXPLICIT_STRENGTH, DEFAULT_RUNTIME_TYPES, isSymmetricType } from "./types.js";
import { stableSort } from "./hash.js";
import { trustedRows, LIFECYCLE } from "./lifecycle.js";
import { relationshipId } from "./ids.js";
import type { RelCandidate, RelInspectionDoc, RelLifecycleResult, RelationshipArtifact, RelationshipEdge } from "../types.js";

function emptyRelationships(): Record<string, RelationshipEdge[]> {
  return {};
}

function edgeProvenance(row: RelCandidate): string | null {
  if (row.decisionRecord?.provenance) return row.decisionRecord.provenance;
  if (row.lifecycle === LIFECYCLE.MANUAL_ACCEPTED) return "manual";
  if (row.lifecycle === LIFECYCLE.HUMAN_ACCEPTED) return "human-reviewed";
  return "human-reviewed";
}

function explicitStrength(row: RelCandidate): number {
  const p = row.decisionRecord?.priority;
  if (p != null && Number.isFinite(Number(p))) {
    const n = Number(p);
    return Math.max(0, Math.min(1, n));
  }
  return EXPLICIT_STRENGTH;
}

function pushEdge(bag: Map<string, RelationshipEdge[]>, source: string, edge: RelationshipEdge) {
  if (!bag.has(source)) bag.set(source, []);
  const list = bag.get(source) || [];
  if (list.some((e) => e.target === edge.target && e.type === edge.type)) return;
  list.push(edge);
}

export function compileTrusted(life: RelLifecycleResult): RelationshipArtifact {
  const bag = new Map<string, RelationshipEdge[]>();
  for (const row of trustedRows(life)) {
    const edge = {
      target: row.resolvedTarget || "",
      type: row.type,
      strength: explicitStrength(row),
      provenance: edgeProvenance(row),
    };
    pushEdge(bag, row.resolvedSource || "", edge);
    if (isSymmetricType(row.type, { directional: row.directional })) {
      pushEdge(bag, row.resolvedTarget || "", { ...edge, target: row.resolvedSource || "" });
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

export function filterRelationships(
  artifact: RelationshipArtifact | null | undefined,
  { types = DEFAULT_RUNTIME_TYPES }: { types?: readonly string[] } = {}
): RelationshipArtifact {
  const allow = new Set(types);
  const relationships = emptyRelationships();
  for (const [source, edges] of Object.entries(artifact?.relationships || {})) {
    const kept = (edges || []).filter((e) => allow.has(e.type || ""));
    if (kept.length) relationships[source] = kept;
  }
  return { format: ARTIFACT_FORMAT, version: artifact?.version || 1, relationships };
}

export function inspectLifecycle(
  life: RelLifecycleResult,
  { delta = null, queueStats = null }: { delta?: unknown; queueStats?: unknown } = {}
): RelInspectionDoc {
  const byLife: Record<string, unknown[]> = {};
  for (const c of life.candidates || []) {
    const k = c.lifecycle || "UNKNOWN";
    if (!byLife[k]) byLife[k] = [];
    byLife[k].push({
      id: c.id,
      type: c.type,
      source: c.source,
      target: c.target,
      resolvedSource: c.resolvedSource,
      resolvedTarget: c.resolvedTarget,
      lifecycle: c.lifecycle,
      directional: c.directional,
      note: c.note || null,
      evidence: c.evidence || {},
      reasons: c.reasons || [],
      flags: c.flags || [],
      reviewBand: c.reviewBand || null,
      decisionSkeleton: {
        candidateId: c.id,
        decision: "accept",
        source: c.source,
        target: c.target,
        type: c.type,
      },
    });
  }
  const pending = (byLife[LIFECYCLE.REVIEW_PENDING] || []).slice();
  return {
    format: "search-relationships-inspection",
    version: 1,
    lifecycle: byLife,
    pending,
    orphaned: life.orphaned || [],
    conflicts: life.conflicts || [],
    delta,
    queueStats,
    counts: {
      manualAccepted: (byLife[LIFECYCLE.MANUAL_ACCEPTED] || []).length,
      humanAccepted: (byLife[LIFECYCLE.HUMAN_ACCEPTED] || []).length,
      reviewPending: pending.length,
      humanRejected: (byLife[LIFECYCLE.HUMAN_REJECTED] || []).length,
      orphaned: (life.orphaned || []).length,
      conflicts: (life.conflicts || []).length,
    },
  };
}

export { relationshipId };
