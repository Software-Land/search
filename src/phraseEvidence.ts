/**
 * Exact typed-surface phrase evidence.
 *
 * Production computation: positional postings (same facts as the former scan).
 * Token count is metadata only.
 */

import { PHRASE_FIELDS, positionalIndexOf } from "./positionalIndex.js";
import { emptyExecutionStats, executePhraseQuery } from "./positionalQueries.js";
import type { AnalyzedQuery, ExactPhraseEvidence, ExactPhraseHit, SearchIndex } from "./types.js";

export type { ExactPhraseEvidence, ExactPhraseHit };

/** Production path is positional postings, not a corpus scan. */
export const PHRASE_EVIDENCE_COMPUTATION = "positional" as const;

export function typedSurfacePhraseTokens(query: AnalyzedQuery): string[] {
  return (query.originalSurface || []).filter(Boolean);
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

function docsContainingToken(index: SearchIndex, token: string): Set<number> {
  const pos = positionalIndexOf(index);
  const docs = new Set<number>();
  for (const field of PHRASE_FIELDS) {
    const postings = pos.fields[field].terms.get(token)?.byDoc;
    if (!postings) continue;
    for (const d of postings.keys()) docs.add(d);
  }
  return docs;
}

export function computeExactPhraseEvidence(query: AnalyzedQuery, index: SearchIndex): ExactPhraseEvidence | null {
  const tokens = typedSurfacePhraseTokens(query);
  if (tokens.length < 2) return null;
  const uniqueTokens = uniqueFirstSeen(tokens);
  const tokenDfs = uniqueTokens.map((token) => ({ token, df: docsContainingToken(index, token).size }));
  let conjunction: Set<number> | null = null;
  for (const token of uniqueTokens) {
    const docs = docsContainingToken(index, token);
    if (!conjunction) {
      conjunction = new Set(docs);
      continue;
    }
    for (const d of conjunction) {
      if (!docs.has(d)) conjunction.delete(d);
    }
  }
  const conjunctionDf = conjunction ? conjunction.size : 0;
  const hits = executePhraseQuery({ kind: "phrase", tokens }, index, emptyExecutionStats()) as ExactPhraseHit[];
  return {
    tokens,
    tokenCount: tokens.length,
    corpusSize: index.documents.length,
    phraseDf: hits.length,
    conjunctionDf,
    selectivity: conjunctionDf > 0 ? hits.length / conjunctionDf : null,
    tokenDfs,
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

export function exactPhraseExplainRecord(
  evidence: ExactPhraseEvidence | null,
  query: AnalyzedQuery,
  hit?: ExactPhraseHit | null
): Record<string, unknown> {
  if (!evidence) return { exactPhrase: null };
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
