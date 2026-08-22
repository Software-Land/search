/**
 * Hand-computed relevance metric cases.
 * Expected values come from the formulas in benchmarks/relevance/README.md,
 * not from calling the production aggregators to invent oracles.
 */
import {
  DuplicateRankingIdError,
  UnknownRankingIdError,
  aggregateQueryMetrics,
  dcgAtK,
  ndcgGain,
  queryMetrics,
} from "../benchmarks/relevance/lib/metrics.mjs";

function grades(map) {
  return map;
}

describe("relevance metric primitives", () => {
  test("NDCG gain is 2^grade - 1", () => {
    expect(ndcgGain(0)).toBe(0);
    expect(ndcgGain(1)).toBe(1);
    expect(ndcgGain(2)).toBe(3);
    expect(ndcgGain(3)).toBe(7);
  });

  test("DCG@k uses log2(rank + 1) and truncates to k", () => {
    // rank 1: 7 / log2(2) = 7
    // rank 2: 3 / log2(3)
    expect(dcgAtK([3, 2], 5)).toBeCloseTo(7 + 3 / Math.log2(3), 12);
    expect(dcgAtK([3, 2, 1], 1)).toBe(7);
  });
});

describe("relevance queryMetrics (hand-computed)", () => {
  test("perfect ranking of mixed grades", () => {
    const g = grades({ a: 3, b: 2, c: 1, d: 0, e: 0 });
    const m = queryMetrics(["a", "b", "c", "d", "e"], g);
    expect(m.mrrAt5).toBe(1);
    expect(m.mrrAt10).toBe(1);
    expect(m.recallAt5).toBe(1);
    expect(m.recallAt10).toBe(1);
    // Ideal order is the returned order, so NDCG = 1.
    expect(m.ndcgAt5).toBe(1);
    expect(m.ndcgAt10).toBe(1);
    expect(m.eligibleMrrRecall).toBe(true);
    expect(m.eligibleNdcgAt5).toBe(true);
  });

  test("first relevant at rank 2", () => {
    const g = grades({ a: 0, b: 3, c: 0 });
    const m = queryMetrics(["a", "b", "c"], g);
    expect(m.mrrAt5).toBe(1 / 2);
    expect(m.mrrAt10).toBe(1 / 2);
    expect(m.recallAt5).toBe(1);
    expect(m.recallAt10).toBe(1);
    // DCG@5 = 0/log2(2) + 7/log2(3) + 0/log2(4)
    // IDCG@5 = 7/log2(2) = 7
    // NDCG@5 = 1 / log2(3)
    expect(m.ndcgAt5).toBeCloseTo(1 / Math.log2(3), 12);
    expect(m.ndcgAt10).toBeCloseTo(1 / Math.log2(3), 12);
  });

  test("relevant document outside k=5 but inside k=10", () => {
    const g = grades({ z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, rel: 3 });
    const m = queryMetrics(["z1", "z2", "z3", "z4", "z5", "rel"], g);
    expect(m.mrrAt5).toBe(0);
    expect(m.mrrAt10).toBe(1 / 6);
    expect(m.recallAt5).toBe(0);
    expect(m.recallAt10).toBe(1);
    // DCG@5 = 0, IDCG@5 = 7, NDCG@5 = 0
    expect(m.ndcgAt5).toBe(0);
    // DCG@10 = 7 / log2(7), IDCG@10 = 7, NDCG@10 = 1 / log2(7)
    expect(m.ndcgAt10).toBeCloseTo(1 / Math.log2(7), 12);
  });

  test("relevant document not returned at all", () => {
    const g = grades({ a: 0, b: 0, rel: 2 });
    const m = queryMetrics(["a", "b"], g);
    expect(m.mrrAt5).toBe(0);
    expect(m.mrrAt10).toBe(0);
    expect(m.recallAt5).toBe(0);
    expect(m.recallAt10).toBe(0);
    expect(m.ndcgAt5).toBe(0);
    expect(m.ndcgAt10).toBe(0);
  });

  test("multiple graded relevant documents in ideal order", () => {
    const g = grades({ a: 3, b: 2, c: 2, d: 0 });
    const m = queryMetrics(["a", "b", "c", "d"], g);
    expect(m.mrrAt5).toBe(1);
    expect(m.recallAt5).toBe(1);
    expect(m.ndcgAt5).toBe(1);
    expect(m.relevantCount).toBe(3);
  });

  test("NDCG of a non-ideal ordering", () => {
    const g = grades({ a: 3, b: 1 });
    const ideal = queryMetrics(["a", "b"], g);
    expect(ideal.ndcgAt5).toBe(1);
    const swapped = queryMetrics(["b", "a"], g);
    // DCG = 1/log2(2) + 7/log2(3) = 1 + 7/log2(3)
    // IDCG = 7/log2(2) + 1/log2(3) = 7 + 1/log2(3)
    const expected = (1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3));
    expect(swapped.ndcgAt5).toBeCloseTo(expected, 12);
    expect(swapped.ndcgAt5).toBeLessThan(1);
    expect(swapped.mrrAt5).toBe(1 / 2);
  });

  test("grade-1-only query is NDCG-eligible and MRR/Recall-ineligible", () => {
    const g = grades({ a: 1, b: 0 });
    const m = queryMetrics(["a", "b"], g);
    expect(m.eligibleMrrRecall).toBe(false);
    expect(m.mrrAt5).toBeNull();
    expect(m.mrrAt10).toBeNull();
    expect(m.recallAt5).toBeNull();
    expect(m.recallAt10).toBeNull();
    expect(m.eligibleNdcgAt5).toBe(true);
    // DCG = 1/log2(2) = 1, IDCG = 1, NDCG = 1
    expect(m.ndcgAt5).toBe(1);
    expect(m.ndcgAt10).toBe(1);
  });

  test("query with no positive judgments is ineligible for every aggregate", () => {
    const g = grades({ a: 0, b: 0 });
    const m = queryMetrics(["a", "b"], g);
    expect(m.eligibleMrrRecall).toBe(false);
    expect(m.eligibleNdcgAt5).toBe(false);
    expect(m.eligibleNdcgAt10).toBe(false);
    expect(m.mrrAt5).toBeNull();
    expect(m.recallAt5).toBeNull();
    expect(m.ndcgAt5).toBeNull();
    expect(m.ndcgAt10).toBeNull();
    expect(m.idcgAt5).toBe(0);
  });

  test("recall with multiple relevant documents", () => {
    const g = grades({ a: 2, b: 2, c: 2, d: 0 });
    const m = queryMetrics(["a", "d"], g);
    expect(m.recallAt5).toBe(1 / 3);
    expect(m.recallAt10).toBe(1 / 3);
    expect(m.mrrAt5).toBe(1);
    // DCG@5 = 3/log2(2) + 0 = 3
    // IDCG@5 = 3/log2(2) + 3/log2(3) + 3/log2(4) = 3 + 3/log2(3) + 1.5
    const expectedNdcg = 3 / (4.5 + 3 / Math.log2(3));
    expect(m.ndcgAt5).toBeCloseTo(expectedNdcg, 12);
  });

  test("duplicate returned document IDs are rejected", () => {
    const g = grades({ a: 3, b: 0 });
    expect(() => queryMetrics(["a", "a"], g)).toThrow(DuplicateRankingIdError);
    expect(() => queryMetrics(["a", "a"], g)).toThrow(/duplicate document id in ranking: a/);
  });

  test("ranked id without a judgment is rejected, not treated as zero", () => {
    const g = grades({ a: 3 });
    expect(() => queryMetrics(["mystery"], g)).toThrow(UnknownRankingIdError);
  });

  test("empty result list", () => {
    const g = grades({ a: 3, b: 0 });
    const m = queryMetrics([], g);
    expect(m.mrrAt5).toBe(0);
    expect(m.mrrAt10).toBe(0);
    expect(m.recallAt5).toBe(0);
    expect(m.recallAt10).toBe(0);
    expect(m.ndcgAt5).toBe(0);
    expect(m.ndcgAt10).toBe(0);
    expect(m.eligibleMrrRecall).toBe(true);
  });
});

describe("relevance aggregateQueryMetrics eligibility", () => {
  test("all-zero query does not pull MRR/NDCG toward zero", () => {
    const relevant = queryMetrics(["hit"], { hit: 3, miss: 0 });
    const none = queryMetrics(["miss"], { hit: 0, miss: 0 });
    const agg = aggregateQueryMetrics([relevant, none]);
    expect(agg.totalQueries).toBe(2);
    expect(agg.queriesWithRelevantDocuments).toBe(1);
    expect(agg.queriesWithNoRelevantDocuments).toBe(1);
    expect(agg.mrrAt5.value).toBe(1);
    expect(agg.mrrAt5.eligible).toBe(1);
    expect(agg.ndcgAt5.value).toBe(1);
    expect(agg.ndcgAt5.eligible).toBe(1);
    expect(agg.recallAt5.value).toBe(1);
    expect(agg.recallAt5.eligible).toBe(1);
  });

  test("grade-1-only query joins NDCG but not MRR/Recall", () => {
    const relevant = queryMetrics(["hit", "bg"], { hit: 2, bg: 1 });
    const background = queryMetrics(["hit", "bg"], { hit: 1, bg: 1 });
    const agg = aggregateQueryMetrics([relevant, background]);
    expect(agg.mrrAt5.eligible).toBe(1);
    expect(agg.recallAt10.eligible).toBe(1);
    expect(agg.ndcgAt5.eligible).toBe(2);
    expect(agg.ndcgAt10.eligible).toBe(2);
    expect(agg.ndcgAt5.value).toBe(1);
  });

  test("MRR averages only eligible queries", () => {
    const first = queryMetrics(["a", "b"], { a: 3, b: 0 });
    const second = queryMetrics(["x", "a"], { a: 3, x: 0 });
    const agg = aggregateQueryMetrics([first, second]);
    expect(agg.mrrAt5.value).toBe((1 + 1 / 2) / 2);
    expect(agg.mrrAt5.eligible).toBe(2);
  });
});
