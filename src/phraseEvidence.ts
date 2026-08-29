/**
 * Exact typed-surface phrase evidence.
 *
 * Identity is `query.originalSurface` after the existing tokenizer
 * (lowercase + punctuation folding). Contiguous equality only: no lemmas,
 * typo correction, configured alias rewriting, prefix matching, or semantic
 * expansion.
 *
 * This module records corpus facts. Ranking and result-set policy live
 * elsewhere. Token count is metadata only.
 *
 * Computation: full scan of each document's ordered `titleTokens` /
 * `summaryTokens` / `bodyTokens` arrays. Complexity is O(D * (Q + Lt + Ls + Lb))
 * per query. The function signature does not expose the scan; a later
 * positional-postings backend can implement the same evidence object without
 * callers changing.
 */

import { sequenceCount } from "./retrieve.js";
import type {
  AnalyzedQuery,
  ExactPhraseEvidence,
  ExactPhraseHit,
  IndexedDocument,
  SearchIndex,
} from "./types.js";

export type { ExactPhraseEvidence, ExactPhraseHit };

/** How phrase statistics were produced. Not part of the evidence facts. */
export const PHRASE_EVIDENCE_COMPUTATION = "scan" as const;

export function typedSurfacePhraseTokens(query: AnalyzedQuery): string[] {
  return (query.originalSurface || []).filter(Boolean);
}

function fieldTokenSet(doc: IndexedDocument, field: "title" | "summary" | "body"): Set<string> | undefined {
  if (field === "title") return doc.titleTokenSet;
  if (field === "body") return doc.bodyTokenSet;
  return doc.summaryTokenSet;
}

function documentContainsToken(doc: IndexedDocument, token: string): boolean {
  if (doc.titleTokenSet.has(token) || doc.bodyTokenSet.has(token)) return true;
  const summarySet = fieldTokenSet(doc, "summary");
  return Boolean(summarySet && summarySet.has(token));
}

function uniqueFirstSeen(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function summaryTokensOf(doc: IndexedDocument): string[] {
  return doc.summaryTokens || [];
}

/**
 * Exact phrase evidence for every genuine multi-token query.
 * One-token (and empty) queries have no phrase-order evidence and return null.
 * Token count is recorded on the object; it does not decide whether evidence exists.
 */
export function computeExactPhraseEvidence(
  query: AnalyzedQuery,
  index: SearchIndex
): ExactPhraseEvidence | null {
  const tokens = typedSurfacePhraseTokens(query);
  if (tokens.length < 2) return null;

  const documents = index.documents;
  const corpusSize = documents.length;
  const uniqueTokens = uniqueFirstSeen(tokens);

  const tokenDfCounts = uniqueTokens.map(() => 0);
  const tokenIndex = new Map(uniqueTokens.map((token, i) => [token, i]));
  let conjunctionDf = 0;
  const hits: ExactPhraseHit[] = [];

  for (const document of documents) {
    let allPresent = true;
    for (const token of uniqueTokens) {
      const present = documentContainsToken(document, token);
      if (present) tokenDfCounts[tokenIndex.get(token)!] += 1;
      else allPresent = false;
    }
    if (allPresent) conjunctionDf += 1;

    const titleFrequency = sequenceCount(tokens, document.titleTokens);
    const summaryFrequency = sequenceCount(tokens, summaryTokensOf(document));
    const bodyFrequency = sequenceCount(tokens, document.bodyTokens);
    if (titleFrequency > 0 || summaryFrequency > 0 || bodyFrequency > 0) {
      hits.push({ document, titleFrequency, summaryFrequency, bodyFrequency });
    }
  }

  const phraseDf = hits.length;
  return {
    tokens,
    tokenCount: tokens.length,
    corpusSize,
    phraseDf,
    conjunctionDf,
    selectivity: conjunctionDf > 0 ? phraseDf / conjunctionDf : null,
    tokenDfs: uniqueTokens.map((token, i) => ({ token, df: tokenDfCounts[i] })),
    hits,
  };
}

function phraseHitFieldLabel(hit: ExactPhraseHit): string | null {
  const fields = [
    hit.titleFrequency > 0 ? "title" : null,
    hit.summaryFrequency > 0 ? "summary" : null,
    hit.bodyFrequency > 0 ? "body" : null,
  ].filter(Boolean);
  return fields.length ? fields.join("+") : null;
}

/** Future explain sketch. Not attached to public search output. */
export function exactPhraseExplainRecord(
  evidence: ExactPhraseEvidence | null,
  query: AnalyzedQuery,
  hit?: ExactPhraseHit | null
): Record<string, unknown> {
  if (!evidence) {
    return { exactPhrase: null };
  }
  return {
    exactPhrase: {
      df: evidence.phraseDf,
      conjunctionDf: evidence.conjunctionDf,
      selectivity: evidence.selectivity,
      tokenCount: evidence.tokenCount,
      field: hit ? phraseHitFieldLabel(hit) : null,
      titleFrequency: hit?.titleFrequency ?? null,
      summaryFrequency: hit?.summaryFrequency ?? null,
      bodyFrequency: hit?.bodyFrequency ?? null,
    },
    configuredIntent: query.configuredSequenceIntent?.key || null,
    versionIntent: Array.isArray(query.dottedSpans) && query.dottedSpans.length ? query.dottedSpans : null,
  };
}
