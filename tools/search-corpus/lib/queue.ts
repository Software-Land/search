/**
 * Review-queue quality: family grouping + explainable priority bands.
 * Does not change candidate IDs or lifecycle. Never used as runtime confidence.
 */

import { stableSort, contentTokens } from "./text.js";
import { LIFECYCLE } from "./lifecycle.js";
import type { CorpusCandidate, EquivalenceCandidate, ReviewContribution, SynonymCandidate } from "../types.js";

const BAND_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function ev(c: CorpusCandidate) {
  return c.evidence || {};
}

function singularPhrase(c: CorpusCandidate): string {
  const tokens = [...(c.expansion || [])];
  if (!tokens.length) return c.expansionPhrase || "";
  const last = tokens[tokens.length - 1];
  if (last.endsWith("s") && last.length > 3 && !last.endsWith("ss")) {
    tokens[tokens.length - 1] = last.slice(0, -1);
  }
  return tokens.join(" ");
}

function aliasShortTerm(c: SynonymCandidate): string {
  const terms = [...(c.terms || [])].map((t) => String(t).toLowerCase());
  if (terms.length < 2) return "";
  const [s, l] = [...terms].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (l.startsWith(s) && s.length >= 4) return s;
  return "";
}

function aliasRemainder(c: SynonymCandidate): string {
  const terms = [...(c.terms || [])].map((t) => String(t).toLowerCase());
  if (terms.length < 2) return "";
  const [s, l] = [...terms].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!l.startsWith(s)) return "";
  return l.slice(s.length);
}

const WEAK_ALIAS_REMAINDER = /^(?:ious|evious|eous|ial)$/;

function expansionSignature(c: CorpusCandidate): string {
  const content = contentTokens(c.expansion || []).map((t) => {
    if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss")) return t.slice(0, -1);
    return t;
  });
  return content.join("-") || String(c.expansionPhrase || "").replace(/\s+/g, "-");
}

export function familyIdFor(c: CorpusCandidate): string {
  if (c.type === "synonym-candidate") {
    const short = aliasShortTerm(c as SynonymCandidate);
    if (short) return `synonym-family:${short}`;
    const terms = [...(c.terms || [])].map((t) => String(t).toLowerCase()).sort();
    return `synonym-family:${terms.join(":")}`;
  }
  // Same key + same content tokens (and/of stripped, plural folded). Competing
  // expansions of one acronym stay separate review tasks.
  return `equivalence-family:${c.key}:${expansionSignature(c)}`;
}

function priorityContributions(c: CorpusCandidate, { acceptedKeys = new Set<string>() }: { acceptedKeys?: Set<string> } = {}): ReviewContribution[] {
  const e = ev(c);
  const parts: ReviewContribution[] = [];
  if ((e.explicitDefinitions || 0) >= 1) parts.push({ name: "explicit-definition", weight: 40 });
  if (c.initialsMatch) parts.push({ name: "exact-initialism", weight: 15 });
  if ((e.titleCooccurrences || 0) >= 1 && (e.bodyCooccurrences || 0) >= 1) {
    parts.push({ name: "title-and-body", weight: 25 });
  } else if ((e.titleKeyBodyPhrase || 0) >= 1) {
    parts.push({ name: "title-key-body-phrase", weight: 22 });
  } else if ((e.titleCooccurrences || 0) >= 1) {
    parts.push({ name: "title-cooccurrence", weight: 10 });
  }
  if ((e.expansionDf || 0) >= 2) parts.push({ name: "independent-expansion", weight: 12 });
  if ((e.supportingDocuments || 0) >= 2) parts.push({ name: "multi-document", weight: 8 });
  if (c.relation === "alias" && (e.titleDfA || e.titleDfB)) parts.push({ name: "alias-title-presence", weight: 10 });
  if (e.explicitAlias) parts.push({ name: "explicit-alias-pattern", weight: 18 });
  if (e.manualSeed || c.flags?.includes("orphaned-but-complete")) parts.push({ name: "manual-seed", weight: 12 });

  if (c.key && acceptedKeys.has(c.key) && c.lifecycle === LIFECYCLE.REVIEW_PENDING) {
    parts.push({ name: "redundant-to-accepted", weight: -30 });
  }
  if (String(c.key || "").length <= 2 && (e.explicitDefinitions || 0) === 0) {
    parts.push({ name: "short-token-penalty", weight: -8 });
  }
  if (c.flags?.includes("competing-expansion") || c.lifecycle === LIFECYCLE.CONFLICT) {
    parts.push({ name: "ambiguity-penalty", weight: -20 });
  }
  if (c.morphologyRedundant) parts.push({ name: "morphology-redundant", weight: -40 });
  return parts;
}

function bandFrom(c: CorpusCandidate, contributions: ReviewContribution[]): string {
  const score = contributions.reduce((n, p) => n + p.weight, 0);
  const e = ev(c);
  if (c.compilerStatus === "rejected" || c.lifecycle === "COMPILER_REJECTED" || c.lifecycle === LIFECYCLE.HUMAN_REJECTED) {
    return "LOW";
  }
  if (c.morphologyRedundant || c.familyRole === "redundant-to-accepted") return "LOW";
  if (c.type === "synonym-candidate" && WEAK_ALIAS_REMAINDER.test(aliasRemainder(c as SynonymCandidate))) return "LOW";
  if ((e.explicitDefinitions || 0) >= 1 && c.initialsMatch) return "HIGH";
  if (c.recommendation === "likely-equivalence" && c.initialsMatch) return "HIGH";
  if ((e.titleKeyBodyPhrase || 0) >= 1 && c.initialsMatch) return "HIGH";
  if ((e.titleCooccurrences || 0) >= 1 && (e.expansionDf || 0) >= 2 && c.initialsMatch) return "MEDIUM";
  if (c.relation === "alias" && ((e.titleDfA || 0) >= 1 || (e.titleDfB || 0) >= 1) && (e.dfA || 0) >= 2 && (e.dfB || 0) >= 2) {
    return "MEDIUM";
  }
  if (c.relation === "alias" && (e.fromEquivalence || e.explicitAlias)) return "MEDIUM";
  if (c.relation === "alias" && score >= 20) return "MEDIUM";
  if (score >= 35) return "HIGH";
  if (score >= 15) return "MEDIUM";
  return "LOW";
}

function comparePriority(a: CorpusCandidate, b: CorpusCandidate): number {
  const br = (BAND_RANK[a.reviewBand || "LOW"] ?? 9) - (BAND_RANK[b.reviewBand || "LOW"] ?? 9);
  if (br !== 0) return br;
  const sc = (b.reviewScore || 0) - (a.reviewScore || 0);
  if (sc !== 0) return sc;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

/**
 * Group + score pending-quality metadata. Lifecycle is unchanged.
 */
export function annotateReviewQueue<T extends CorpusCandidate>(rows: T[], { acceptedKeys = new Set<string>() }: { acceptedKeys?: Set<string> } = {}): T[] {
  const byFamily = new Map<string, T[]>();
  const annotated = rows.map((c) => {
    const familyId = familyIdFor(c);
    const contributions = priorityContributions(c, { acceptedKeys });
    const reviewScore = contributions.reduce((n, p) => n + p.weight, 0);
    const row = {
      ...c,
      familyId,
      familyRole: "member",
      reviewScore,
      reviewContributions: contributions,
      reviewBand: "LOW",
    } as T;
    row.reviewBand = bandFrom(row, contributions);
    if (!byFamily.has(familyId)) byFamily.set(familyId, []);
    (byFamily.get(familyId) || []).push(row);
    return row;
  });

  for (const members of byFamily.values()) {
    const acceptedMember = members.find(
      (m) => m.lifecycle === LIFECYCLE.AUTO_ACCEPTED || m.lifecycle === LIFECYCLE.HUMAN_ACCEPTED
    );
    const pending = members.filter((m) => m.lifecycle === LIFECYCLE.REVIEW_PENDING);
    const canonical =
      acceptedMember ||
      [...pending].sort((a, b) => {
        const band = (BAND_RANK[a.reviewBand || "LOW"] ?? 9) - (BAND_RANK[b.reviewBand || "LOW"] ?? 9);
        if (band) return band;
        if ((b.reviewScore || 0) !== (a.reviewScore || 0)) return (b.reviewScore || 0) - (a.reviewScore || 0);
        return singularPhrase(a).length - singularPhrase(b).length || String(a.id).localeCompare(String(b.id));
      })[0] ||
      members[0];

    for (const m of members) {
      if (m.id === canonical.id) m.familyRole = "canonical";
      else if (acceptedMember && m.lifecycle === LIFECYCLE.REVIEW_PENDING) {
        m.familyRole = "redundant-to-accepted";
        m.reviewBand = "LOW";
        m.reviewContributions = [...(m.reviewContributions || []), { name: "redundant-to-accepted", weight: -30 }];
        m.reviewScore = (m.reviewScore || 0) - 30;
      } else if (singularPhrase(m) === singularPhrase(canonical)) m.familyRole = "surface-variant";
      else m.familyRole = "related";
      m.canonicalId = canonical.id;
    }
  }

  for (const row of annotated) {
    if (
      row.key &&
      acceptedKeys.has(row.key) &&
      row.lifecycle === LIFECYCLE.REVIEW_PENDING &&
      row.familyRole !== "redundant-to-accepted"
    ) {
      const trusted = annotated.find(
        (a) =>
          a.key === row.key &&
          (a.lifecycle === LIFECYCLE.AUTO_ACCEPTED || a.lifecycle === LIFECYCLE.HUMAN_ACCEPTED)
      );
      if (trusted && trusted.id !== row.id) {
        row.familyRole = "redundant-to-accepted";
        row.reviewBand = "LOW";
        row.reviewContributions = [...(row.reviewContributions || []), { name: "redundant-to-accepted", weight: -30 }];
        row.reviewScore = (row.reviewScore || 0) - 30;
        row.canonicalId = trusted.id;
      }
    }
  }

  return stableSort(annotated, (c) => `${BAND_RANK[c.reviewBand || "LOW"] ?? 9}:${String(1000 - (c.reviewScore || 0)).padStart(4, "0")}:${c.id}`);
}

export function sortPending(rows?: unknown): CorpusCandidate[] {
  const list = Array.isArray(rows) ? (rows as CorpusCandidate[]) : [];
  return [...list].sort(comparePriority);
}

export function decisionSkeleton(c?: unknown) {
  const row = c as CorpusCandidate | undefined;
  if (row?.type === "synonym-candidate") {
    return {
      candidateId: row.id,
      decision: "accept",
      terms: row.terms,
      relation: row.relation || "alias",
    };
  }
  return {
    candidateId: row?.id,
    decision: "accept",
    key: row?.key,
    expansion: row?.expansion,
  };
}

export function isCanonicalPending(c: CorpusCandidate): boolean {
  return c.lifecycle === LIFECYCLE.REVIEW_PENDING && c.familyRole === "canonical";
}

export function familySummaries(rows: CorpusCandidate[]) {
  const byId = new Map<string, { id: string; type?: string; canonicalId?: string; reviewBand?: unknown; memberIds: unknown[] }>();
  for (const c of rows) {
    if (!c.familyId) continue;
    if (!byId.has(c.familyId)) {
      byId.set(c.familyId, {
        id: c.familyId,
        type: c.type,
        canonicalId: c.canonicalId || c.id,
        reviewBand: c.reviewBand,
        memberIds: [],
      });
    }
    const fam = byId.get(c.familyId)!;
    fam.memberIds.push(c.id);
    if (c.familyRole === "canonical") {
      fam.canonicalId = c.id;
      fam.reviewBand = c.reviewBand;
    }
  }
  return stableSort([...byId.values()], (f) => `${BAND_RANK[String(f.reviewBand || "LOW")] ?? 9}:${f.id}`);
}

export function queueStats(equivalences: EquivalenceCandidate[], synonyms: SynonymCandidate[]) {
  function tally(rows: CorpusCandidate[]) {
    const pending = rows.filter((r) => r.lifecycle === LIFECYCLE.REVIEW_PENDING);
    const canonicalPending = pending.filter((r) => r.familyRole === "canonical");
    const bandCounts: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const r of canonicalPending) {
      const band = r.reviewBand || "LOW";
      bandCounts[band] = (bandCounts[band] || 0) + 1;
    }
    return {
      raw: rows.length,
      pending: pending.length,
      canonicalPending: canonicalPending.length,
      variants: pending.filter((r) => r.familyRole !== "canonical").length,
      bands: bandCounts,
    };
  }
  return { equivalences: tally(equivalences), synonyms: tally(synonyms) };
}

export { BAND_RANK };
