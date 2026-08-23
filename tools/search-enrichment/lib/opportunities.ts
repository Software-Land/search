import { LIFECYCLE } from "../../search-corpus/lib/lifecycle.js";
import { isCanonicalPending } from "../../search-corpus/lib/queue.js";
import { normalizeExpansion } from "../../search-corpus/lib/text.js";
import { INFERENCE_SCHEMA_VERSION, PROMPT_ID } from "./prompt.js";
import type { AnalyzeResult, EquivalenceCandidate } from "../../search-corpus/types.js";
import type { LexicalInferenceRequest } from "../types.js";

export function selectOpportunities(analysis: AnalyzeResult, { maxOpportunities = 200 }: { maxOpportunities?: number } = {}): EquivalenceCandidate[] {
  const rows = (analysis.life?.equivalences || []).filter(
    (c) =>
      c.lifecycle === LIFECYCLE.REVIEW_PENDING &&
      isCanonicalPending(c) &&
      c.key &&
      (c.expansion || []).length &&
      c.initialsMatch
  );
  return rows.slice(0, Math.max(0, maxOpportunities));
}

export function requestFromCandidate(candidate: EquivalenceCandidate): LexicalInferenceRequest {
  return {
    schemaVersion: INFERENCE_SCHEMA_VERSION,
    promptId: PROMPT_ID,
    task: "adjudicate-abbreviation",
    key: candidate.key,
    minedExpansion: candidate.expansion || [],
    evidence: { ...(candidate.evidence || {}) },
    alternatives: [],
  };
}

/**
 * Expansion-only inference request: an attested phrase whose conventional
 * acronym is not yet a mined key. Does not enumerate corpus n-grams.
 */
export function requestFromPhrase(phrase: string[]): LexicalInferenceRequest {
  const tokens = normalizeExpansion(phrase);
  return {
    schemaVersion: INFERENCE_SCHEMA_VERSION,
    promptId: PROMPT_ID,
    task: "propose-expansion",
    key: "",
    phrase: tokens,
    minedExpansion: tokens,
    evidence: {},
    alternatives: [],
  };
}

export function findCandidate(rows: EquivalenceCandidate[], key: string, expansion: string[]): EquivalenceCandidate | null {
  const phrase = (expansion || []).join(" ");
  return (
    rows.find((c) => c.key === key && (c.expansionPhrase || (c.expansion || []).join(" ")) === phrase) ||
    rows.find((c) => c.key === key) ||
    null
  );
}
