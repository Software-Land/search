import {
  acronymKey,
  initialsMatch,
  isPlausibleAcronymKey,
  isProtectedLiteral,
  phraseKey,
} from "../../search-corpus/lib/text.js";
import { hasStrongIndependentEvidence } from "../../search-corpus/lib/classify.js";
import { LIFECYCLE } from "../../search-corpus/lib/lifecycle.js";
import type { EquivalenceCandidate } from "../../search-corpus/types.js";
import type { InferenceProposal } from "../types.js";

export function expansionsEqual(a: string[] = [], b: string[] = []): boolean {
  return phraseKey(a) === phraseKey(b);
}

function sameKey(a: unknown, b: unknown): boolean {
  return acronymKey(a) === acronymKey(b) && acronymKey(a).length > 0;
}

function isCompilerOrHumanRejected(row: EquivalenceCandidate): boolean {
  if (row.lifecycle === LIFECYCLE.HUMAN_REJECTED) return true;
  if (row.lifecycle === LIFECYCLE.ORPHANED_DECISION) return true;
  if (row.lifecycle === "COMPILER_REJECTED") return true;
  if (row.compilerStatus === "rejected" || row.status === "rejected") return true;
  return false;
}

/** Still live in the current analysis: not compiler-rejected and not human-rejected. */
export function isViableCandidate(row: EquivalenceCandidate): boolean {
  if (!row || !row.key) return false;
  return !isCompilerOrHumanRejected(row);
}

/**
 * Any other live expansion for the same key, including REVIEW_PENDING and CONFLICT.
 * Trusted rivals are a subset of this set.
 */
export function hasViableRival(
  rows: EquivalenceCandidate[],
  key: string,
  expansion: string[],
  exceptId?: string
): boolean {
  return rows.some(
    (c) =>
      sameKey(c.key, key) &&
      c.id !== exceptId &&
      !expansionsEqual(c.expansion || [], expansion) &&
      isViableCandidate(c)
  );
}

export function hasTrustedRival(rows: EquivalenceCandidate[], key: string, expansion: string[], exceptId?: string): boolean {
  return rows.some(
    (c) =>
      sameKey(c.key, key) &&
      c.id !== exceptId &&
      (c.lifecycle === LIFECYCLE.AUTO_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED) &&
      !expansionsEqual(c.expansion || [], expansion)
  );
}

/**
 * Verified automatic acceptance predicate.
 *
 * Requires all of:
 * - autoAcceptVerified === true
 * - a deterministic mined candidate (model-only never accepts)
 * - lifecycle is not HUMAN_REJECTED / CONFLICT
 * - proposal.relation is not reject
 * - proposal.ambiguous === false and no conflicting alternatives
 * - model expansion equals the mined expansion (normalized)
 * - strict initials relationship
 * - protected-literal / acronym plausibility
 * - key occurs in corpus (keyDf >= 1)
 * - expansion occurs in corpus (expansionDf >= 1)
 * - strong independent deterministic evidence
 * - no viable competing expansion, including REVIEW_PENDING rivals
 *
 * Model numeric confidence is ignored.
 */
export function shouldAutoAcceptVerified({
  enabled,
  candidate,
  proposal,
  peers,
}: {
  enabled: boolean;
  candidate: EquivalenceCandidate | null;
  proposal: InferenceProposal;
  peers: EquivalenceCandidate[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!enabled) {
    reasons.push("autoAcceptVerified is off");
    return { ok: false, reasons };
  }
  if (!candidate) {
    reasons.push("model-only proposals never auto-accept");
    return { ok: false, reasons };
  }
  if (candidate.lifecycle === LIFECYCLE.HUMAN_REJECTED || candidate.lifecycle === LIFECYCLE.CONFLICT) {
    reasons.push(`lifecycle ${candidate.lifecycle} blocks auto-accept`);
    return { ok: false, reasons };
  }
  if (proposal.relation === "reject") {
    reasons.push("model rejected the pair");
    return { ok: false, reasons };
  }
  if (proposal.ambiguous || proposal.alternatives.some((alt) => !expansionsEqual(alt.expansion, proposal.expansion))) {
    reasons.push("model output is ambiguous");
    return { ok: false, reasons };
  }
  if (!proposal.expansion.length || !expansionsEqual(proposal.expansion, candidate.expansion || [])) {
    reasons.push("model expansion does not match mined expansion");
    return { ok: false, reasons };
  }
  if (!isPlausibleAcronymKey(candidate.key, { original: candidate.key })) {
    reasons.push("key is not a plausible acronym");
    return { ok: false, reasons };
  }
  if (isProtectedLiteral(candidate.key) && (candidate.expansion || []).length > 1 && !initialsMatch(candidate.key, candidate.expansion || [])) {
    reasons.push("protected literal cannot expand without initials match");
    return { ok: false, reasons };
  }
  if (!initialsMatch(candidate.key, candidate.expansion || [])) {
    reasons.push("initials do not match");
    return { ok: false, reasons };
  }
  const evidence = (candidate.evidence || {}) as Record<string, unknown>;
  const keyDf = Number(evidence.keyDf || evidence.keyDf || 0);
  const expansionDf = Number(evidence.expansionDf || evidence.expansionDf || 0);
  if (keyDf < 1) {
    reasons.push("key does not occur in corpus");
    return { ok: false, reasons };
  }
  if (expansionDf < 1) {
    reasons.push("expansion does not occur in corpus");
    return { ok: false, reasons };
  }
  if (!hasStrongIndependentEvidence(candidate.evidence || {})) {
    reasons.push("missing strong independent deterministic evidence");
    return { ok: false, reasons };
  }
  if (hasViableRival(peers, candidate.key, candidate.expansion || [], candidate.id)) {
    reasons.push("viable rival expansion exists");
    return { ok: false, reasons };
  }
  return { ok: true, reasons: ["verified-enrichment"] };
}
