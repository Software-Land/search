import { buildQueryPlan } from "../../dist/query/queryPlan.js";
import {
  compileRankingEvidencePlan,
  rankingEvidenceEligibilityReason,
} from "../../dist/rankingEvidencePlan.js";
import {
  RankingEvidenceSessionPool,
  rankingEvidenceStaticFor,
} from "../../dist/rankingEvidenceState.js";
import {
  finalizeRankingEvidence,
  readRankingEvidenceFactsForTest,
} from "../../dist/rankingEvidenceFinalize.js";
import {
  retrieveWithRankingEvidence,
  retrieveWithRankingEvidenceAsync,
} from "../../dist/retrieval/retrievers.js";
import { extractFeatures } from "../../dist/features.js";
import { scoreFeatures } from "../../dist/rank.js";

export const REPRESENTED_FIELDS = [
  "exactTitleMatch",
  "exactTitleTokenMatch",
  "typedSurfaceTitleMatch",
  "titleCoverage",
  "queryCoverage",
  "titlePrefixQuality",
  "contextualTitlePrefix",
  "matchedPrefixTokens",
  "activeFinalPrefix",
  "completedTitleToken",
  "unmatchedTitleTokensAfter",
  "titleSequenceTightness",
  "contextualPrefixQuality",
  "configuredConceptMatch",
  "morphologyMatch",
  "typoDistance",
  "versionMatch",
  "shortLiteralLeadMatch",
  "dottedSpanComponentTitleMatch",
  "phraseAdjacency",
  "bodyLexicalMatch",
  "lexicalConceptCoverage",
  "coverageConceptCount",
  "ordinaryEquivalenceBodyMatch",
  "titleTokenCount",
  "configuredFormEvidence",
  "configuredFormCoverage",
  "configuredFormBodyMatch",
  "canonicalKeyTitle",
  "queryTokenCount",
  "normalizedQueryPhrase",
  "matchingPhraseKey",
  "bodyPhraseCount",
  "bodyPhraseFrequency",
  "titlePhraseFrequency",
  "summaryPhraseFrequency",
  "exactTitleOrSummaryPhrase",
  "relationshipStrength",
  "relationshipType",
  "relationshipSourceId",
  "retrievalScore",
  "relevanceKind",
  "directClass",
];

export const RETRIEVAL_STAT_FIELDS = [
  "postingEntriesVisited",
  "postingEntriesSkipped",
  "postingBlocksVisited",
  "postingBlocksSkipped",
  "duplicatePostingEntriesAvoided",
  "duplicatePostingBlocksAvoided",
  "queryFormsExpanded",
  "termsExpanded",
  "distinctDocumentsExamined",
  "exactMatches",
  "rawDocumentScans",
  "postingBlocksTotal",
  "postingBlocksDecoded",
  "postingBlocksClassifiedFromMasks",
  "postingBlocksSkippedUnread",
  "postingEntriesDecoded",
  "candidateDocumentsMaterialized",
  "provenanceDocumentsScanned",
  "stage3A",
  "stage3AFallbackReason",
];

export function retrievalRows(hits) {
  return hits.map((hit) => ({
    id: hit.document.id,
    ordinal: hit.documentOrdinal,
    retrievalSources: [...(hit.retrievalSources || [])],
    retrievalScore: hit.retrievalScore || 0,
  }));
}

export function retrievalStats(stats) {
  return Object.fromEntries(RETRIEVAL_STAT_FIELDS.map((key) => [key, stats[key]]));
}

function sameValue(left, right) {
  if (!Array.isArray(left) && !Array.isArray(right)) return left === right;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function diffFinalized(query, hits, finalized) {
  let primitiveMismatches = 0;
  let scoreMismatches = 0;
  const samples = [];
  for (let candidate = 0; candidate < hits.length; candidate++) {
    const actual = readRankingEvidenceFactsForTest(finalized, candidate);
    const oracle = extractFeatures(query, hits[candidate].document, {
      relationship: null,
      retrievalScore: 0,
    });
    for (const field of REPRESENTED_FIELDS) {
      const left = actual.features[field];
      const right = oracle[field];
      if (!sameValue(left, right)) {
        primitiveMismatches += 1;
        if (samples.length < 12) {
          samples.push({
            id: hits[candidate].document.id,
            field,
            actual: left,
            oracle: right,
          });
        }
      }
    }
    const actualField = actual.features.configuredConceptFieldEvidence;
    const oracleField = oracle.configuredConceptFieldEvidence;
    if (
      actualField.title !== oracleField.title ||
      actualField.summary !== oracleField.summary ||
      actualField.body !== oracleField.body
    ) {
      primitiveMismatches += 1;
      if (samples.length < 12) {
        samples.push({
          id: hits[candidate].document.id,
          field: "configuredConceptFieldEvidence",
          actual: actual.features.configuredConceptFieldEvidence,
          oracle: oracle.configuredConceptFieldEvidence,
        });
      }
    }
    const oracleScore = Number(scoreFeatures(oracle).toFixed(6));
    if (actual.score !== oracleScore) {
      scoreMismatches += 1;
      if (samples.length < 12) {
        samples.push({
          id: hits[candidate].document.id,
          field: "score",
          actual: actual.score,
          oracle: oracleScore,
        });
      }
    }
  }
  return {
    candidates: hits.length,
    primitiveMismatches,
    scoreMismatches,
    samples,
  };
}

export function prepareEvidence(engine, rawQuery, pool = new RankingEvidenceSessionPool()) {
  const query = engine._prepareQuery(rawQuery);
  const queryPlan = buildQueryPlan(query, engine._index);
  const staticState = rankingEvidenceStaticFor(engine._index);
  const compiled = compileRankingEvidencePlan(staticState, query);
  return { query, queryPlan, staticState, compiled, pool };
}

export function runEvidence(
  engine,
  rawQuery,
  {
    pool = new RankingEvidenceSessionPool(),
    retrievalOptions = {
      skipDuplicatePostingLists: true,
      exactBlockSkip: { requiredDepth: 10 },
    },
  } = {}
) {
  const prepared = prepareEvidence(engine, rawQuery, pool);
  if (!prepared.compiled.eligible) {
    return {
      ...prepared,
      eligible: false,
      reason: prepared.compiled.reason,
      hits: [],
      finalized: null,
      diff: null,
    };
  }
  const session = pool.acquire(prepared.compiled.plan);
  try {
    const hits = retrieveWithRankingEvidence(
      engine.retriever,
      prepared.query,
      engine._index,
      session,
      retrievalOptions
    );
    if (!hits) throw new Error("compiled retriever evidence capability missing");
    const finalized = finalizeRankingEvidence(session, hits, prepared.queryPlan);
    const diff = diffFinalized(prepared.query, hits, finalized);
    return {
      ...prepared,
      eligible: true,
      reason: null,
      session,
      hits,
      finalized,
      diff,
      retrievalStats: engine.retriever.stats(),
    };
  } catch (error) {
    session.abort();
    throw error;
  }
}

export async function runEvidenceAsync(
  engine,
  rawQuery,
  pool,
  retrievalOptions = {
    skipDuplicatePostingLists: true,
    exactBlockSkip: { requiredDepth: 10 },
  }
) {
  const prepared = prepareEvidence(engine, rawQuery, pool);
  if (!prepared.compiled.eligible) {
    return { ...prepared, eligible: false, reason: prepared.compiled.reason };
  }
  const session = pool.acquire(prepared.compiled.plan);
  try {
    const hits = await retrieveWithRankingEvidenceAsync(
      engine.retriever,
      prepared.query,
      engine._index,
      session,
      retrievalOptions
    );
    if (!hits) throw new Error("compiled retriever evidence capability missing");
    const finalized = finalizeRankingEvidence(session, hits, prepared.queryPlan);
    return {
      ...prepared,
      eligible: true,
      reason: null,
      session,
      hits,
      finalized,
      diff: diffFinalized(prepared.query, hits, finalized),
    };
  } catch (error) {
    session.abort();
    throw error;
  }
}

export function releaseEvidence(run) {
  if (run?.session) run.session.release();
}

export function eligibilityForQuery(engine, rawQuery) {
  const query = engine._prepareQuery(rawQuery);
  const state = rankingEvidenceStaticFor(engine._index);
  return rankingEvidenceEligibilityReason(query, state);
}
