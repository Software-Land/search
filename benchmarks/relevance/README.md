# Relevance evaluation (Phase 1)

Development-only machinery for **distributional query-document relevance** metrics. This directory is not a claimed search-quality benchmark.

The toy fixture exists to prove that corpus loading, exhaustive-judgment validation, `SearchEngine` invocation, metric calculation, and output formatting work. **Do not cite toy numbers as evidence of ranking quality.**

These files are **not** in the published npm tarball (`package.json` `files` does not include `benchmarks/`).

## What this is for

Search Core already has Jest **invariants and regressions**: exact orders, constraint behavior, public-API contracts. Those tests are the right place to lock “this query must rank this document first” for a tiny fixture.

They are the wrong place to measure whether ranking is *generally* good. Distributional relevance evaluation asks: over a judged query set, how often are relevant documents near the top (MRR, Recall) and how well is graded relevance ordered (NDCG)?

This Phase 1 tree is the **ruler**. A later phase can add a real human-judged corpus. Until then there is no baseline search-quality number in this repository.

## What this is not

- Not a replacement for regression/invariant tests.
- Not a live or production corpus.
- Not a blind holdout. A public checked-in reserved subset (not used in Phase 1) would only be a procedural anti-tuning convention.
- Not a license to retune ranking against the toy fixture.

## Rubric (grades 0–3)

| Grade | Meaning |
| --- | --- |
| 0 | Irrelevant |
| 1 | Related / background |
| 2 | Relevant |
| 3 | Highly relevant / direct |

**Binary relevance** for MRR and Recall: `grade >= 2`. Grade 1 is not a hit.

**Judgments must be made without looking at current engine rank**, scores, constraint names, or explanations. The judgment file must not store those fields.

## Exhaustive judgments

For this initial format, every query **must** contain a grade for **every** document in the referenced corpus.

The validator rejects:

- missing document judgments
- judgment IDs not present in the corpus
- grades outside 0–3
- duplicate query IDs
- duplicate document IDs
- malformed `format` / `version`
- a judgment file whose `corpus` field does not match the corpus `id`

**Unjudged documents are not treated as zero.** Completeness is required so the first small corpora stay trustworthy.

## Formats

Corpus (`benchmarks/relevance/corpora/<id>/documents.json`):

```json
{
  "format": "search-relevance-corpus",
  "version": 1,
  "id": "toy",
  "documents": [{ "id": "alpha", "title": "Alpha", "body": "..." }]
}
```

Judgments (`benchmarks/relevance/judgments/<id>.json`):

```json
{
  "format": "search-relevance-eval",
  "version": 1,
  "corpus": "toy",
  "queries": [
    {
      "id": "toy-alpha",
      "query": "alpha",
      "judgments": { "alpha": 3, "beta": 0, "gamma": 0 }
    }
  ]
}
```

Judgments do not include rank, engine score, expected ordering, constraint names, or SearchEngine output.

## Metric formulas

Cutoff `k` ∈ {5, 10}. Rank is 1-based. Returned lists shorter than `k` contribute 0 in the unused slots (unretrieved).

**Gain** (NDCG): `2^grade - 1`

**Discount**: `log2(rank + 1)`

**DCG@k** = Σ_{r=1..min(k, |results|)} gain(grade_r) / log2(r + 1)

**IDCG@k** = DCG@k of the ideal ordering of *all judged documents* (every corpus document, since judgments are exhaustive), truncated to `k`.

**NDCG@k** = DCG@k / IDCG@k

**MRR@k**: let `r` be the rank of the first result with `grade >= 2` and `r <= k`. Reciprocal rank is `1/r`, or `0` if none.

**Recall@k** = (number of results in the top `k` with `grade >= 2`) / (number of corpus documents with `grade >= 2`)

**Duplicate returned document IDs are rejected.** SearchEngine is not expected to emit duplicates; silently keeping the first copy would hide bugs.

A ranked ID that has no judgment is also rejected (never coerced to grade 0).

## Aggregate eligibility

Queries with no relevant documents, or with IDCG@k = 0, are **not** forced into the average as zeros.

| Metric | Eligible queries |
| --- | --- |
| MRR@k | at least one document with `grade >= 2` |
| Recall@k | same |
| NDCG@k | IDCG@k > 0 (at least one document with `grade >= 1`) |

A query whose judgments are all 0 is excluded from MRR, Recall, and NDCG. A grade-1-only query is excluded from MRR and Recall but included in NDCG.

Every aggregate is reported with its eligibility count. The report also includes:

- `totalQueries`
- `queriesWithRelevantDocuments` (`grade >= 2` somewhere)
- `queriesWithNoRelevantDocuments`

Phase 1 does not define a custom “no result” metric.

## Toy fixture

`corpora/toy` + `judgments/toy.json` is a **3-document, 3-query smoke fixture**:

- `toy-alpha` — one highly relevant document (`alpha`: 3)
- `toy-background` — grade-1 only (all documents related, none relevant)
- `toy-none` — all zeros

It is enough to exercise loading, validation, public `SearchEngine.search`, metrics, eligibility, and stable JSON. It is **not** a ranking-quality benchmark.

## Runner

Requires a built runtime (`npm run build`). Public API only (`SearchEngine`, `morphology` from `dist/index.js`). No network, models, or generated embeddings.

```bash
node benchmarks/relevance/run.mjs --corpus toy
node benchmarks/relevance/run.mjs --corpus toy --json
node benchmarks/relevance/run.mjs --corpus toy --query toy-alpha
node benchmarks/relevance/run.mjs --corpus toy --worst 2
```

Queries are processed and printed in stable query-id order. `--query` is a case-insensitive substring filter on query id or query text. `--worst N` lists the N lowest NDCG@10 query ids among NDCG-eligible queries.

Default search `limit` is 10 so @5 and @10 are defined against the same public API default.

## Tests

Hand-computed metric cases live in `test/relevance-metrics.test.js`. They do not call `SearchEngine` and do not take expected values from the production aggregators by round-tripping: expected numbers are written from the formulas above.

Validator cases: `test/relevance-validate.test.js`. Runner / determinism: `test/relevance-runner.test.js`.

No CI job yet. Validate locally. A Node 22 reporting job can wait until a real human-judged corpus exists.
