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

/** @param {import("../types.js").EvidenceHit[] | undefined} provenance */
function reviewerExamples(provenance) {
  return (provenance || []).slice(0, 3);
}

/** @param {import("../types.js").CorpusCandidate} c @returns {import("../types.js").ReviewerRow} */
function reviewerRow(c) {
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

/** @param {import("../types.js").EquivalenceCandidate[]} candidates @returns {import("../types.js").EquivalenceArtifact} */
export function compileEquivalences(candidates) {
  const accepted = trustedEquivalences(candidates);
  /** @type {Map<string, import("../types.js").EquivalenceCandidate>} */
  const byKey = new Map();
  /** @type {Array<{ key: string, reason: string, ids: unknown[] }>} */
  const skipped = [];
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
    type: "equivalence",
    provenance:
      c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED
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

/** @param {import("../types.js").SynonymCandidate[]} candidates @returns {import("../types.js").SynonymArtifact} */
export function compileSynonyms(candidates) {
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

/** @param {import("../types.js").LifecycleResult} lifecycleResult @param {{ delta?: import("../types.js").InspectionDelta | null }} [opts] @returns {import("../types.js").InspectionDoc} */
export function compileInspection(lifecycleResult, { delta = null } = {}) {
  const eq = lifecycleResult.equivalences || [];
  const syn = lifecycleResult.synonyms || [];
  /** @type {{ accepted: import("../types.js").EquivalenceCandidate[], review: import("../types.js").EquivalenceCandidate[], rejected: import("../types.js").EquivalenceCandidate[] }} */
  const buckets = { accepted: [], review: [], rejected: [] };
  for (const c of stableSort(eq, (x) => `${x.compilerStatus}:${x.key}:${x.expansionPhrase}`)) {
    const bucket = c.compilerStatus === "accepted" ? "accepted" : c.compilerStatus === "review" ? "review" : "rejected";
    buckets[bucket].push(c);
  }
  /** @type {Record<string, import("../types.js").ReviewerRow[]>} */
  const byLifecycle = {};
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

/** @param {import("../types.js").EquivalenceArtifact | { entries?: unknown[] } | null | undefined} artifact */
export function dictionaryEntriesFromEquivalences(artifact) {
  return (artifact?.entries || []).map((e) => {
    const row = /** @type {{ key?: unknown, expansion?: unknown, aliases?: unknown, provenance?: unknown }} */ (e);
    return {
      key: row.key,
      expansion: row.expansion,
      aliases: row.aliases || [],
      provenance: row.provenance,
    };
  });
}

/** @param {{ corpusHash?: string | null, decisionsHash?: string | null, inspection?: import("../types.js").InspectionDoc, equivalences?: unknown, synonyms?: unknown, timings?: unknown }} opts */
export function compileManifest({ corpusHash, decisionsHash, inspection, equivalences, synonyms, timings }) {
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
