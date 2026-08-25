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
  EquivalenceArtifact,
  EquivalenceCandidate,
  EvidenceHit,
  InspectionDelta,
  InspectionDoc,
  LifecycleResult,
  ReviewerRow,
  SynonymArtifact,
  SynonymCandidate,
} from "../types.js";

function standaloneRecallOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const token = String(item ?? "").toLowerCase().trim();
    if (!token || /\s/.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
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

export function compileEquivalences(candidates: EquivalenceCandidate[]): EquivalenceArtifact {
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
  const entries = stableSort([...byKey.values()], (e) => e.key || "").map((c) => ({
    key: c.key || "",
    expansion: c.expansion || [],
    aliases: c.aliases || [],
    primary: c.primary ?? null,
    standaloneRecall: standaloneRecallOf((c as { standaloneRecall?: unknown }).standaloneRecall),
    type: "equivalence",
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
  }));
  return {
    format: "search-v2-equivalences",
    version: 1,
    entries,
    compileWarnings: skipped,
  };
}

export function compileSynonyms(candidates: SynonymCandidate[]): SynonymArtifact {
  const accepted = trustedSynonyms(candidates);
  const entries = stableSort(accepted, (e) => (e.terms || []).join(":")).map((c) => ({
    terms: c.terms || [],
    type: c.relation || "synonym",
    provenance:
      c.override === "manual" || c.flags?.includes("orphaned-but-complete")
        ? "manual-addition"
        : "human-accepted",
    confidence: null,
  }));
  return {
    format: "search-v2-synonyms",
    version: 1,
    entries,
  };
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

export function dictionaryEntriesFromEquivalences(artifact?: unknown): unknown[] {
  const rec = artifact as { entries?: unknown[] } | null | undefined;
  return (rec?.entries || []).map((e) => {
    const row = e as { key?: unknown; expansion?: unknown; aliases?: unknown; provenance?: unknown; primary?: unknown; standaloneRecall?: unknown };
    return {
      key: row.key,
      expansion: row.expansion,
      aliases: row.aliases || [],
      primary: row.primary ?? null,
      standaloneRecall: standaloneRecallOf(row.standaloneRecall),
      provenance: row.provenance,
    };
  });
}

export function compileManifest({
  corpusHash,
  decisionsHash,
  inspection,
  equivalences,
  synonyms,
  timings,
}: {
  corpusHash?: string | null;
  decisionsHash?: string | null;
  inspection?: InspectionDoc;
  equivalences?: unknown;
  synonyms?: unknown;
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
      equivalences: hashJson(equivalences),
      synonyms: hashJson(synonyms),
    },
    timings: timings || null,
  };
}
