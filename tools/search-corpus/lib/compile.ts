import { stableSort } from "./text.js";
import { LIFECYCLE, trustedEquivalences, trustedSynonyms } from "./lifecycle.js";
import { hashJson } from "./hash.js";
import {
  sortPending,
  decisionSkeleton,
  queueStats,
  familySummaries,
  isCanonicalPending,
} from "./queue.js";
import type {
  CorpusCandidate,
  ConfiguredConceptArtifact,
  EquivalenceCandidate,
  EvidenceHit,
  InspectionDelta,
  InspectionDoc,
  LifecycleResult,
  ReviewerRow,
  GeneratedRelationshipMap,
  SynonymCandidate,
} from "../types.js";

export const CONFIGURED_CONCEPT_FORMAT = "search-v2-configured-concepts";
const REMOVED_CONCEPT_FIELDS = ["expansion", "exp", "primary", "standaloneRecall", "topicalRecall"];

function failConfiguredConcept(message: string): never {
  throw new Error(message);
}

/**
 * Fail-closed reader for corpus `search-v2-configured-concepts` artifacts.
 * Does not accept `search-v2-equivalences`.
 */
export function parseConfiguredConcepts(obj?: unknown): ConfiguredConceptArtifact {
  if (obj == null) {
    return { format: CONFIGURED_CONCEPT_FORMAT, version: 1, entries: [], compileWarnings: [] };
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    failConfiguredConcept("configured-concept artifact must be a plain object");
  }
  const rec = obj as Record<string, unknown>;
  if (rec.format === "search-v2-equivalences") {
    failConfiguredConcept(
      "search-v2-equivalences is not supported; regenerate as search-v2-configured-concepts"
    );
  }
  if (!rec.format) failConfiguredConcept("configured-concept artifact is missing required field \"format\"");
  if (rec.format !== CONFIGURED_CONCEPT_FORMAT) {
    failConfiguredConcept(`Expected format ${CONFIGURED_CONCEPT_FORMAT}, got ${JSON.stringify(rec.format)}`);
  }
  const version = rec.version == null ? null : Number(rec.version);
  if (version == null) failConfiguredConcept("configured-concept artifact is missing required field \"version\"");
  if (!Number.isInteger(version) || version < 1) {
    failConfiguredConcept(`Invalid artifact version for ${CONFIGURED_CONCEPT_FORMAT}: ${JSON.stringify(rec.version)}`);
  }
  if (version !== 1) {
    failConfiguredConcept(
      `Unsupported ${CONFIGURED_CONCEPT_FORMAT} version ${version}; this runtime reads version 1 only`
    );
  }
  const entries = Array.isArray(rec.entries) ? rec.entries : [];
  return {
    format: CONFIGURED_CONCEPT_FORMAT,
    version: 1,
    entries: entries
      .filter((e) => e && typeof e === "object" && (e as { key?: unknown }).key)
      .map((e) => {
        const row = e as Record<string, unknown>;
        const found = REMOVED_CONCEPT_FIELDS.filter((field) => field in row);
        if (found.length) {
          failConfiguredConcept(`configured-concept entries must be { key, aliases }; found ${found.join(", ")}`);
        }
        const aliases = Array.isArray(row.aliases)
          ? row.aliases
              .filter((alias) => Array.isArray(alias) && alias.length)
              .map((alias) => (alias as unknown[]).map((w) => String(w).toLowerCase()))
          : [];
        return {
          key: String(row.key).toLowerCase(),
          ...(typeof row.type === "string" ? { type: row.type } : {}),
          aliases,
          provenance: row.provenance == null ? null : String(row.provenance),
          confidence: row.confidence == null ? null : Number(row.confidence),
          reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
        };
      }),
    compileWarnings: Array.isArray(rec.compileWarnings) ? rec.compileWarnings : [],
  };
}

function reviewerExamples(provenance: EvidenceHit[] | undefined): EvidenceHit[] {
  return (provenance || []).slice(0, 3);
}

function reviewerRow(c: CorpusCandidate): ReviewerRow {
  return {
    id: c.id,
    type: c.type,
    key: c.key,
    expansion: c.expansion,
    expansionPhrase: c.expansionPhrase,
    terms: c.terms,
    relation: c.relation,
    compilerStatus: c.compilerStatus,
    compilerDecision: c.compilerDecision,
    recommendation: c.recommendation,
    lifecycle: c.lifecycle,
    initialsMatch: c.initialsMatch,
    evidence: c.evidence,
    aliases: "aliases" in c ? c.aliases : undefined,
    primary: "primary" in c ? (c as EquivalenceCandidate).primary : undefined,
    examples: reviewerExamples(c.provenance),
    reasons: c.reasons || [],
    flags: c.flags || [],
    familyId: c.familyId || null,
    familyRole: c.familyRole || null,
    canonicalId: c.canonicalId || c.id,
    reviewBand: c.reviewBand || null,
    reviewScore: c.reviewScore ?? null,
    reviewContributions: c.reviewContributions || [],
    decisionSkeleton: c.lifecycle === LIFECYCLE.REVIEW_PENDING ? decisionSkeleton(c) : null,
  };
}

export function compileConfiguredConcepts(candidates: EquivalenceCandidate[]): ConfiguredConceptArtifact {
  const accepted = trustedEquivalences(candidates);
  const byKey = new Map<string, EquivalenceCandidate>();
  const skipped: Array<{ key: string; reason: string; ids: unknown[] }> = [];
  for (const c of accepted) {
    const key = c.key || "";
    if (byKey.has(key)) {
      skipped.push({ key, reason: "duplicate-trusted-key", ids: [byKey.get(key)?.id, c.id] });
      continue;
    }
    byKey.set(key, c);
  }
  const entries = stableSort([...byKey.values()], (e) => e.key || "").map((c) => {
    const expansion = Array.isArray(c.expansion) ? c.expansion.map((w) => String(w).toLowerCase()) : [];
    const extra = Array.isArray(c.aliases)
      ? (c.aliases as unknown[]).filter((alias): alias is string[] => Array.isArray(alias) && alias.length > 0)
      : [];
    const seen = new Set<string>();
    const aliases: string[][] = [];
    for (const seq of [...(expansion.length ? [expansion] : []), ...extra]) {
      const key = seq.join("\u001f");
      if (!seq.length || seen.has(key)) continue;
      seen.add(key);
      aliases.push([...seq]);
    }
    aliases.sort((a, b) => a.join("\u001f").localeCompare(b.join("\u001f")));
    return {
      key: c.key || "",
      aliases,
      type: "configured-concept",
      provenance:
        c.flags?.includes("verified-enrichment")
          ? "verified-enrichment"
          : c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED
            ? c.override === "add" || c.flags?.includes("orphaned-but-complete")
              ? "manual-addition"
              : "human-accepted"
            : "search-corpus",
      confidence: null,
      reasons: c.reasons || [],
    };
  });
  return {
    format: CONFIGURED_CONCEPT_FORMAT,
    version: 1,
    entries,
    compileWarnings: skipped,
  };
}

/**
 * Trusted human-accepted synonym groups compile to a directional
 * relationshipMap clique. A group { terms: ["a","b","c"] } becomes every
 * ordered equivalent pair so historical symmetric reachability is preserved.
 * Review metadata (relation/provenance/confidence) stays on inspection /
 * decisions, not on runtime edges.
 */
export function compileEquivalentRelationshipMap(candidates: SynonymCandidate[]): GeneratedRelationshipMap {
  const accepted = trustedSynonyms(candidates);
  const bySource = new Map<string, Set<string>>();
  for (const c of accepted) {
    const terms = [
      ...new Set((c.terms || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean)),
    ];
    if (terms.length < 2) continue;
    for (const source of terms) {
      if (!bySource.has(source)) bySource.set(source, new Set());
      for (const target of terms) {
        if (source !== target) bySource.get(source)!.add(target);
      }
    }
  }
  const map: GeneratedRelationshipMap = {};
  for (const source of [...bySource.keys()].sort()) {
    map[source] = [...bySource.get(source)!].sort().map((target) => ({
      to: { form: target },
      kind: "equivalent",
    }));
  }
  return map;
}

export function compileInspection(lifecycleResult: LifecycleResult, { delta = null }: { delta?: InspectionDelta | null } = {}): InspectionDoc {
  const eq = lifecycleResult.equivalences || [];
  const syn = lifecycleResult.synonyms || [];
  const buckets: { accepted: EquivalenceCandidate[]; review: EquivalenceCandidate[]; rejected: EquivalenceCandidate[] } = {
    accepted: [],
    review: [],
    rejected: [],
  };
  for (const c of stableSort(eq, (x) => `${x.compilerStatus}:${x.key}:${x.expansionPhrase}`)) {
    const bucket = c.compilerStatus === "accepted" ? "accepted" : c.compilerStatus === "review" ? "review" : "rejected";
    buckets[bucket].push(c);
  }
  const byLifecycle: Record<string, ReviewerRow[]> = {};
  for (const c of [...eq, ...syn]) {
    const k = c.lifecycle || "UNKNOWN";
    if (!byLifecycle[k]) byLifecycle[k] = [];
    byLifecycle[k].push(reviewerRow(c));
  }
  for (const k of Object.keys(byLifecycle)) {
    byLifecycle[k] = stableSort(byLifecycle[k], (r) => r.id || "");
  }
  const pending = sortPending(eq.filter((c) => isCanonicalPending(c) && c.key && c.expansion)).map(reviewerRow);
  const synonymPending = sortPending(syn.filter((c) => isCanonicalPending(c))).map(reviewerRow);
  const reviewQueue = sortPending([...eq, ...syn].filter(isCanonicalPending)).map(reviewerRow);
  const stats = queueStats(eq, syn);
  return {
    format: "search-corpus-inspection",
    version: 3,
    accepted: buckets.accepted,
    review: buckets.review,
    rejected: buckets.rejected,
    synonymCandidates: syn,
    candidates: eq.map(reviewerRow),
    lifecycle: byLifecycle,
    pending,
    synonymPending,
    reviewQueue,
    families: familySummaries([...eq, ...syn].filter((c) => c.lifecycle === LIFECYCLE.REVIEW_PENDING)),
    queueStats: stats,
    conflicts: lifecycleResult.conflicts || [],
    flags: lifecycleResult.flags || [],
    orphaned: (lifecycleResult.orphaned || []).map(reviewerRow),
    delta,
    counts: {
      accepted: buckets.accepted.length,
      review: buckets.review.length,
      rejected: buckets.rejected.length,
      autoAccepted: eq.filter((c) => c.lifecycle === LIFECYCLE.AUTO_ACCEPTED).length,
      humanAccepted: eq.filter((c) => c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED).length,
      reviewPending: pending.length,
      synonymReview: synonymPending.length,
      reviewPendingAll: eq.filter((c) => c.lifecycle === LIFECYCLE.REVIEW_PENDING).length,
      high: stats.equivalences.bands.HIGH + stats.synonyms.bands.HIGH,
      medium: stats.equivalences.bands.MEDIUM + stats.synonyms.bands.MEDIUM,
      low: stats.equivalences.bands.LOW + stats.synonyms.bands.LOW,
      conflicts: (lifecycleResult.conflicts || []).length,
      orphaned: (lifecycleResult.orphaned || []).length,
      humanRejected: eq.filter((c) => c.lifecycle === LIFECYCLE.HUMAN_REJECTED).length,
      humanAcceptedSynonyms: syn.filter((s) => s.lifecycle === LIFECYCLE.HUMAN_ACCEPTED).length,
    },
  };
}

export function configuredConceptsFromArtifact(artifact?: unknown): Array<{
  key: unknown;
  aliases: string[][];
  type?: unknown;
  provenance: unknown;
  confidence?: unknown;
}> {
  const rec = artifact as { entries?: unknown[] } | null | undefined;
  return (rec?.entries || []).map((e) => {
    const row = e as {
      key?: unknown;
      aliases?: unknown;
      type?: unknown;
      provenance?: unknown;
      confidence?: unknown;
    };
    const aliases = Array.isArray(row.aliases)
      ? (row.aliases as unknown[]).filter((alias): alias is string[] => Array.isArray(alias) && alias.length > 0)
      : [];
    return {
      key: row.key,
      aliases: aliases.map((seq) => [...seq]),
      ...(typeof row.type === "string" ? { type: row.type } : {}),
      provenance: row.provenance,
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
    };
  });
}

export function compileManifest({
  corpusHash,
  decisionsHash,
  inspection,
  configuredConceptArtifact,
  relationshipMap,
  timings,
}: {
  corpusHash?: string | null;
  decisionsHash?: string | null;
  inspection?: InspectionDoc;
  configuredConceptArtifact?: unknown;
  relationshipMap?: unknown;
  timings?: unknown;
}) {
  return {
    format: "search-corpus-manifest",
    version: 1,
    compilerVersion: 1,
    corpusHash: corpusHash || null,
    decisionsHash: decisionsHash || null,
    counts: inspection?.counts || {},
    artifactHashes: {
      configuredConcepts: hashJson(configuredConceptArtifact),
      relationshipMap: hashJson(relationshipMap),
    },
    timings: timings || null,
  };
}
