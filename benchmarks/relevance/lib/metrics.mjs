/**
 * Distributional relevance metrics for exhaustive 0–3 judgments.
 *
 * Binary relevance (MRR, Recall): grade >= 2
 * NDCG gain: 2^grade - 1
 * NDCG discount: log2(rank + 1) with 1-based rank
 *
 * Duplicate ranked IDs are rejected (DuplicateRankingIdError).
 * Ranked IDs without a judgment are rejected (UnknownRankingIdError);
 * missing grades are never treated as zero.
 */

export const BINARY_RELEVANT_MIN_GRADE = 2;
export const METRIC_CUTOFFS = Object.freeze([5, 10]);

export class DuplicateRankingIdError extends Error {
  constructor(message) {
    super(message);
    this.name = "DuplicateRankingIdError";
  }
}

export class UnknownRankingIdError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnknownRankingIdError";
  }
}

export function ndcgGain(grade) {
  return 2 ** grade - 1;
}

/**
 * DCG over `gradesInRankOrder`, truncated to k.
 * Positions past the list contribute 0 (unretrieved).
 */
export function dcgAtK(gradesInRankOrder, k) {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
  const n = Math.min(k, gradesInRankOrder.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const rank = i + 1;
    sum += ndcgGain(gradesInRankOrder[i]) / Math.log2(rank + 1);
  }
  return sum;
}

function idealGrades(gradesById) {
  return Object.keys(gradesById)
    .map((id) => gradesById[id])
    .sort((a, b) => b - a);
}

function assertRanking(rankedIds, gradesById) {
  if (!Array.isArray(rankedIds)) {
    throw new TypeError("rankedIds must be an array");
  }
  if (gradesById == null || typeof gradesById !== "object" || Array.isArray(gradesById)) {
    throw new TypeError("gradesById must be an object");
  }
  const seen = new Set();
  for (const id of rankedIds) {
    if (typeof id !== "string" || id === "") {
      throw new TypeError(`invalid ranked document id: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new DuplicateRankingIdError(`duplicate document id in ranking: ${id}`);
    }
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(gradesById, id)) {
      throw new UnknownRankingIdError(`ranked document id is not judged: ${id}`);
    }
  }
}

function reciprocalRankAtK(rankedIds, gradesById, k) {
  const n = Math.min(k, rankedIds.length);
  for (let i = 0; i < n; i++) {
    if (gradesById[rankedIds[i]] >= BINARY_RELEVANT_MIN_GRADE) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function recallAtK(rankedIds, gradesById, k, relevantCount) {
  const n = Math.min(k, rankedIds.length);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    if (gradesById[rankedIds[i]] >= BINARY_RELEVANT_MIN_GRADE) hits += 1;
  }
  return hits / relevantCount;
}

/**
 * Per-query metrics at k=5 and k=10.
 * Ineligible metrics are `null` (they must not be averaged as zero).
 */
export function queryMetrics(rankedIds, gradesById) {
  assertRanking(rankedIds, gradesById);

  let relevantCount = 0;
  for (const id of Object.keys(gradesById)) {
    if (gradesById[id] >= BINARY_RELEVANT_MIN_GRADE) relevantCount += 1;
  }
  const eligibleMrrRecall = relevantCount > 0;
  const ideal = idealGrades(gradesById);

  const result = {
    relevantCount,
    eligibleMrrRecall,
  };

  for (const k of METRIC_CUTOFFS) {
    const windowGrades = rankedIds.slice(0, k).map((id) => gradesById[id]);
    const dcg = dcgAtK(windowGrades, k);
    const idcg = dcgAtK(ideal, k);
    const eligibleNdcg = idcg > 0;
    const suffix = `At${k}`;

    result[`idcg${suffix}`] = idcg;
    result[`eligibleNdcg${suffix}`] = eligibleNdcg;
    result[`mrr${suffix}`] = eligibleMrrRecall ? reciprocalRankAtK(rankedIds, gradesById, k) : null;
    result[`recall${suffix}`] = eligibleMrrRecall ? recallAtK(rankedIds, gradesById, k, relevantCount) : null;
    result[`ndcg${suffix}`] = eligibleNdcg ? dcg / idcg : null;
  }

  return result;
}

function mean(rows, getValue, isEligible) {
  const eligible = rows.filter(isEligible);
  if (eligible.length === 0) return { value: null, eligible: 0 };
  let sum = 0;
  for (const row of eligible) sum += getValue(row);
  return { value: sum / eligible.length, eligible: eligible.length };
}

/**
 * Macro-average over eligible queries only.
 * MRR / Recall: queries with at least one grade >= 2.
 * NDCG@k: queries whose IDCG@k > 0.
 */
export function aggregateQueryMetrics(rows) {
  const totalQueries = rows.length;
  const queriesWithRelevantDocuments = rows.filter((row) => row.eligibleMrrRecall).length;
  return {
    totalQueries,
    queriesWithRelevantDocuments,
    queriesWithNoRelevantDocuments: totalQueries - queriesWithRelevantDocuments,
    mrrAt5: mean(
      rows,
      (row) => row.mrrAt5,
      (row) => row.eligibleMrrRecall
    ),
    mrrAt10: mean(
      rows,
      (row) => row.mrrAt10,
      (row) => row.eligibleMrrRecall
    ),
    ndcgAt5: mean(
      rows,
      (row) => row.ndcgAt5,
      (row) => row.eligibleNdcgAt5
    ),
    ndcgAt10: mean(
      rows,
      (row) => row.ndcgAt10,
      (row) => row.eligibleNdcgAt10
    ),
    recallAt5: mean(
      rows,
      (row) => row.recallAt5,
      (row) => row.eligibleMrrRecall
    ),
    recallAt10: mean(
      rows,
      (row) => row.recallAt10,
      (row) => row.eligibleMrrRecall
    ),
  };
}
