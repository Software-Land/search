import {
  RelevanceValidationError,
  validateCorpus,
  validateJudgments,
} from "../benchmarks/relevance/lib/validate.mjs";

function corpus(overrides = {}) {
  return {
    format: "search-relevance-corpus",
    version: 1,
    id: "toy",
    documents: [
      { id: "alpha", title: "Alpha", body: "a" },
      { id: "beta", title: "Beta", body: "b" },
    ],
    ...overrides,
  };
}

function judgments(overrides = {}, queryOverrides = {}) {
  return {
    format: "search-relevance-eval",
    version: 1,
    corpus: "toy",
    queries: [
      {
        id: "q1",
        query: "alpha",
        judgments: { alpha: 3, beta: 0 },
        ...queryOverrides,
      },
    ],
    ...overrides,
  };
}

describe("relevance corpus validation", () => {
  test("accepts a well-formed corpus", () => {
    expect(validateCorpus(corpus()).documentIds).toEqual(["alpha", "beta"]);
  });

  test("rejects malformed format and version", () => {
    expect(() => validateCorpus(corpus({ format: "search-v2-documents" }))).toThrow(RelevanceValidationError);
    expect(() => validateCorpus(corpus({ version: 2 }))).toThrow(/expected version 1/);
    expect(() => validateCorpus(corpus({ version: "1" }))).toThrow(/expected version 1/);
  });

  test("rejects duplicate document IDs", () => {
    const c = corpus({
      documents: [
        { id: "alpha", title: "A", body: "a" },
        { id: "alpha", title: "B", body: "b" },
      ],
    });
    expect(() => validateCorpus(c)).toThrow(/duplicate document id "alpha"/);
  });

  test("rejects unknown corpus fields", () => {
    expect(() => validateCorpus(corpus({ rank: 1 }))).toThrow(/unknown field "rank"/);
  });
});

describe("relevance judgment validation", () => {
  test("accepts exhaustive grades for every document", () => {
    expect(validateJudgments(judgments(), corpus()).queryIds).toEqual(["q1"]);
  });

  test("rejects missing document judgments instead of treating them as zero", () => {
    const j = judgments({
      queries: [{ id: "q1", query: "alpha", judgments: { alpha: 3 } }],
    });
    expect(() => validateJudgments(j, corpus())).toThrow(/missing judgment for document "beta"/);
  });

  test("rejects judgment IDs not present in the corpus", () => {
    const j = judgments({
      queries: [{ id: "q1", query: "alpha", judgments: { alpha: 3, beta: 0, gamma: 0 } }],
    });
    expect(() => validateJudgments(j, corpus())).toThrow(/unknown document "gamma"/);
  });

  test("rejects grades outside 0–3", () => {
    const high = judgments({
      queries: [{ id: "q1", query: "alpha", judgments: { alpha: 4, beta: 0 } }],
    });
    const frac = judgments({
      queries: [{ id: "q1", query: "alpha", judgments: { alpha: 1.5, beta: 0 } }],
    });
    expect(() => validateJudgments(high, corpus())).toThrow(/grade must be an integer 0–3/);
    expect(() => validateJudgments(frac, corpus())).toThrow(/grade must be an integer 0–3/);
  });

  test("rejects duplicate query IDs", () => {
    const j = judgments({
      queries: [
        { id: "q1", query: "alpha", judgments: { alpha: 3, beta: 0 } },
        { id: "q1", query: "beta", judgments: { alpha: 0, beta: 3 } },
      ],
    });
    expect(() => validateJudgments(j, corpus())).toThrow(/duplicate query id "q1"/);
  });

  test("rejects a judgment file that refers to the wrong corpus", () => {
    expect(() => validateJudgments(judgments({ corpus: "other" }), corpus())).toThrow(
      /does not match corpus id "toy"/
    );
  });

  test("rejects malformed eval format and version", () => {
    expect(() => validateJudgments(judgments({ format: "search-relevance-corpus" }), corpus())).toThrow(
      RelevanceValidationError
    );
    expect(() => validateJudgments(judgments({ version: 0 }), corpus())).toThrow(/expected version 1/);
  });

  test("rejects rank / score fields on queries", () => {
    const j = judgments({
      queries: [
        {
          id: "q1",
          query: "alpha",
          judgments: { alpha: 3, beta: 0 },
          rank: 1,
        },
      ],
    });
    expect(() => validateJudgments(j, corpus())).toThrow(/unknown field "rank"/);
  });
});
