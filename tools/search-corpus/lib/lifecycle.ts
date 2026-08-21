/**
 * Lifecycle: compiler recommendation is not a human decision.
 *
 * AUTO_ACCEPTED | REVIEW_PENDING | HUMAN_ACCEPTED | HUMAN_REJECTED
 * CONFLICT | ORPHANED_DECISION
 */

import { equivalenceId, synonymId, expansionPhraseOf } from "./ids.js";
import { indexDecisions } from "./decisions.js";
import { stableSort } from "./text.js";
import type { CorpusCandidate, EquivalenceCandidate, EquivalenceEvidence, LifecycleResult, SynonymCandidate } from "../types.js";

export const LIFECYCLE = {
  AUTO_ACCEPTED: "AUTO_ACCEPTED",
  REVIEW_PENDING: "REVIEW_PENDING",
  HUMAN_ACCEPTED: "HUMAN_ACCEPTED",
  HUMAN_REJECTED: "HUMAN_REJECTED",
  CONFLICT: "CONFLICT",
  ORPHANED_DECISION: "ORPHANED_DECISION",
} as const;

function compilerRecommendation(status: unknown, evidence: EquivalenceEvidence | undefined): string {
  if (status === "accepted") return "accept";
  if (status === "rejected") return "reject";
  const ev = evidence || {};
  if ((ev.explicitDefinitions || 0) >= 1 || ((ev.titleCooccurrences || 0) >= 1 && (ev.bodyCooccurrences || 0) >= 1)) {
    return "likely-equivalence";
  }
  return "review";
}

function isStrongCompetitor(c: EquivalenceCandidate | null | undefined): boolean {
  if (!c || c.initialsMatch === false) return false;
  if (c.compilerStatus === "accepted") return true;
  if ((c.evidence?.explicitDefinitions || 0) >= 1) return true;
  if (c.recommendation === "likely-equivalence") return true;
  return false;
}

function competingMined(candidates: EquivalenceCandidate[], key: string, exceptId: string | undefined): EquivalenceCandidate[] {
  return candidates.filter((c) => c.key === key && c.id !== exceptId && isStrongCompetitor(c));
}

export function attachEquivalenceIds(classified: EquivalenceCandidate[]): EquivalenceCandidate[] {
  return classified.map((c) => ({
    ...c,
    id: equivalenceId(c.key, c.expansion),
    compilerStatus: c.status,
    compilerDecision: c.decision,
    recommendation: compilerRecommendation(c.status, c.evidence),
  }));
}

export function attachSynonymIds(rows: SynonymCandidate[]): SynonymCandidate[] {
  return rows.map((c) => ({
    ...c,
    id: synonymId(c.terms),
    compilerStatus: c.status || "review",
    compilerDecision: c.decision,
    recommendation: "review",
  }));
}

/**
 * Apply durable decisions onto generated candidates. Does not mutate the
 * decisions object. Human truth outranks inference.
 */
export function applyLifecycle(classified: EquivalenceCandidate[], synonymRows: SynonymCandidate[], decisions: unknown): LifecycleResult {
  const idx = indexDecisions(decisions);
  const conflicts: Array<Record<string, unknown>> = [];
  const flags: Array<Record<string, unknown>> = [];

  const eq = attachEquivalenceIds(classified).map((c) => ({ ...c }));
  const byId = new Map(eq.map((c) => [c.id || "", c]));

  for (const c of eq) {
    const exact = idx.eqById.get(c.id || "");
    const keyReject = idx.eqRejectKeys.has(c.key);
    const keyDecisions = idx.eqByKey.get(c.key) || [];
    const keyAccept = keyDecisions.find((d) => d.decision === "accept" && d.expansion.length);
    const acceptedOther =
      keyAccept && keyAccept.id !== c.id
        ? keyAccept
        : null;

    c.decisionRecord =
      exact ||
      (keyReject && !exact
        ? {
            id: equivalenceId(c.key, []),
            type: "equivalence",
            decision: "reject",
            key: c.key || "",
            expansion: [],
            expansionPhrase: "",
            aliases: [],
            manual: false,
          }
        : null);
    c.flags = [];

    if (exact?.decision === "reject" || (keyReject && !exact && !keyAccept)) {
      c.lifecycle = LIFECYCLE.HUMAN_REJECTED;
      c.status = "rejected";
      if ((c.evidence?.explicitDefinitions || 0) >= 1 && c.compilerStatus !== "rejected") {
        c.flags.push("rejected-candidate-gained-strong-evidence");
        flags.push({ id: c.id, flag: "rejected-candidate-gained-strong-evidence" });
      }
      continue;
    }

    if (exact?.decision === "accept" || (keyAccept && keyAccept.id === c.id)) {
      const rivals = competingMined(eq, c.key || "", c.id).filter((r) => {
        const rDec = idx.eqById.get(r.id || "");
        if (rDec?.decision === "reject") return false;
        if (idx.eqRejectKeys.has(r.key) && !rDec) return false;
        return true;
      });
      if (rivals.length) {
        c.lifecycle = LIFECYCLE.CONFLICT;
        c.status = "review";
        c.flags.push("ambiguous-trusted-candidate");
        conflicts.push({
          type: "ambiguity-invalidation",
          key: c.key,
          accepted: c.expansionPhrase,
          competing: rivals.map((r) => r.expansionPhrase),
        });
        continue;
      }
      if (acceptedOther && acceptedOther.expansionPhrase !== c.expansionPhrase) {
        c.lifecycle = LIFECYCLE.CONFLICT;
        c.status = "review";
        conflicts.push({
          type: "expansion-drift",
          key: c.key,
          accepted: acceptedOther.expansionPhrase,
          generated: c.expansionPhrase,
        });
        continue;
      }
      c.lifecycle = LIFECYCLE.HUMAN_ACCEPTED;
      c.status = "accepted";
      c.override = exact?.manual || keyAccept?.manual ? "manual" : "accept";
      continue;
    }

    if (acceptedOther && acceptedOther.expansionPhrase !== c.expansionPhrase) {
      if (c.compilerStatus === "accepted" || c.compilerStatus === "review") {
        c.lifecycle = LIFECYCLE.CONFLICT;
        c.status = "review";
        c.flags.push("competing-expansion");
        conflicts.push({
          type: "expansion-drift",
          key: c.key,
          accepted: acceptedOther.expansionPhrase,
          generated: c.expansionPhrase,
        });
        continue;
      }
    }

    if (c.compilerStatus === "accepted") {
      const rivals = competingMined(eq, c.key || "", c.id);
      const humanRejectsRival = rivals.every((r) => {
        const rDec = idx.eqById.get(r.id || "");
        return rDec?.decision === "reject" || idx.eqRejectKeys.has(r.key);
      });
      if (rivals.length && !humanRejectsRival) {
        c.lifecycle = LIFECYCLE.CONFLICT;
        c.status = "review";
        c.flags.push("ambiguous-trusted-candidate");
        conflicts.push({
          type: "auto-accepted-became-ambiguous",
          key: c.key,
          expansions: [c.expansionPhrase, ...rivals.map((r) => r.expansionPhrase)],
        });
        continue;
      }
      c.lifecycle = LIFECYCLE.AUTO_ACCEPTED;
      c.status = "accepted";
      continue;
    }

    if (c.compilerStatus === "review") {
      c.lifecycle = LIFECYCLE.REVIEW_PENDING;
      c.status = "review";
      continue;
    }

    c.lifecycle = "COMPILER_REJECTED";
    c.status = "rejected";
    c.recommendation = c.recommendation || "reject";
  }

  const orphaned: CorpusCandidate[] = [];
  for (const item of idx.loaded.equivalences) {
    if (item.decision === "reject" && item.expansion.length === 0) continue;
    if (byId.has(item.id)) continue;
    const row: EquivalenceCandidate = {
      type: "equivalence-candidate",
      id: item.id,
      key: item.key,
      expansion: item.expansion,
      expansionPhrase: item.expansionPhrase || expansionPhraseOf(item.expansion),
      compilerStatus: "absent",
      compilerDecision: "not-generated",
      recommendation: item.decision === "accept" ? "accept" : "reject",
      initialsMatch: true,
      evidence: { explicitDefinitions: 0, titleCooccurrences: 0, bodyCooccurrences: 0, supportingDocuments: 0, provenances: ["manual-seed"] },
      reasons: ["decision has no current mined candidate"],
      provenance: [{ type: item.manual ? "manual-addition" : "orphaned-decision", documentId: null, field: null, snippet: null }],
      flags: ["orphaned-decision"],
      override: item.manual ? "add" : "accept",
      decisionRecord: item,
    };
    if (item.decision === "accept" && item.expansion.length) {
      row.lifecycle = LIFECYCLE.HUMAN_ACCEPTED;
      row.status = "accepted";
      row.flags = row.flags || [];
      row.flags.push("orphaned-but-complete");
      eq.push(row);
      byId.set(row.id || item.id, row);
    } else {
      row.lifecycle = LIFECYCLE.ORPHANED_DECISION;
      row.status = "rejected";
      orphaned.push(row);
      eq.push(row);
    }
  }

  const syn = attachSynonymIds(synonymRows).map((c) => ({ ...c }));
  const synById = new Map(syn.map((c) => [c.id || "", c]));
  for (const c of syn) {
    const exact = idx.synById.get(c.id || "");
    c.flags = [];
    if (exact?.decision === "reject") {
      c.lifecycle = LIFECYCLE.HUMAN_REJECTED;
      c.status = "rejected";
      continue;
    }
    if (exact?.decision === "accept") {
      c.lifecycle = LIFECYCLE.HUMAN_ACCEPTED;
      c.status = "accepted";
      c.relation = exact.relation || c.relation;
      c.override = exact.manual ? "manual" : "accept";
      continue;
    }
    c.lifecycle = LIFECYCLE.REVIEW_PENDING;
    c.status = "review";
  }
  for (const item of idx.loaded.synonyms) {
    if (synById.has(item.id)) continue;
    const row: SynonymCandidate = {
      type: "synonym-candidate",
      id: item.id,
      terms: item.terms,
      relation: item.relation,
      compilerStatus: "absent",
      compilerDecision: "not-generated",
      recommendation: item.decision === "accept" ? "accept" : "reject",
      evidence: {},
      provenance: [{ type: item.manual ? "manual-addition" : "orphaned-decision" }],
      reasons: ["decision has no current mined candidate"],
      flags: ["orphaned-decision"],
      decisionRecord: item,
    };
    if (item.decision === "accept" && item.terms.length >= 2) {
      row.lifecycle = LIFECYCLE.HUMAN_ACCEPTED;
      row.status = "accepted";
      row.flags = row.flags || [];
      row.flags.push("orphaned-but-complete");
    } else {
      row.lifecycle = LIFECYCLE.ORPHANED_DECISION;
      row.status = "rejected";
      orphaned.push(row);
    }
    syn.push(row);
    synById.set(row.id || item.id, row);
  }

  return {
    equivalences: stableSort(eq, (c) => `${c.lifecycle}:${c.key}:${c.expansionPhrase}`),
    synonyms: stableSort(syn, (c) => `${c.lifecycle}:${(c.terms || []).join(":")}`),
    conflicts,
    flags,
    orphaned,
  };
}

export function trustedEquivalences(rows: EquivalenceCandidate[]): EquivalenceCandidate[] {
  return rows.filter(
    (c) => c.lifecycle === LIFECYCLE.AUTO_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED
  );
}

export function trustedSynonyms(rows: SynonymCandidate[]): SynonymCandidate[] {
  return rows.filter((c) => c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED);
}
