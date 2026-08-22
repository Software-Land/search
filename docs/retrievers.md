# Retrievers

v0 exposes **built-in names only**. A third-party `{ retrieve }` object is accepted as experimental and is not a stable contract (it sees internal query/index shapes). `searchAsync` calls `retrieveAsync` when present and otherwise `retrieve()`.

The public `retriever` field is still `RetrieverName | "indexed-lexical" | { retrieve: Function; retrieveAsync?: Function; prepare?: Function; name?: string }`. `ExperimentalRetriever` / `ExperimentalRetrieveOptions` are opt-in authoring types for that experimental object. `query` and `index` are intentionally `unknown`; those types do not publish `AnalyzedQuery`, `SearchIndex`, or `IndexedDocument`.

```js
SearchEngine.create({
  retriever: "full-scan",   // default
  // retriever: "indexed",
  // retriever: "adaptive",
  candidateLimit: 200,      // indexed budget for non-exact hits
  adaptive: { documentThreshold: 1500 },
});
```

| name | when |
| --- | --- |
| `full-scan` | Small corpora. Simplest. Scans every document. |
| `indexed` | Inverted lexical candidate generation. BM25 **orders the budgeted slice only**. |
| `adaptive` | Full scan while `documentCount <= adaptive.documentThreshold`, else indexed. Deterministic. No runtime benchmarking. |

Default threshold **1500** is a documented default, not a universal law. Settings-like and article-like corpora cross at different sizes. Benchmark unusual shapes.

Must-keep union:

- `exact-title`, `configured-equivalence`, and `version` are **unbounded** deterministic must-keep.
- `contextual-title-prefix` is a **capped** must-keep (`prefixCap`, default 800), ranked by contextual quality then document position. Overflow is not dropped: it remains eligible for the ordinary `candidateLimit` pool, keeps `contextual-title-prefix` in `retrievalSources`, and competes by `retrievalScore` with deterministic pos tie-break.

Title-token / body / other prefix hits are budgeted by `candidateLimit`.

`candidateLimit` default is 200. BM25 `k1`/`b` and title boost are implementation defaults, not public knobs.

## BM25

Useful as a **candidate retriever**. Not the final relevance algorithm. Default ranking weight of any BM25 score is **0**. A non-zero weight helped one corpus shape and hurt another.

## Scaling (measured, not universal)

On a Node / x86_64 harness:

- Settings-like ~1k remained interactive under full scan (p95 ~18 ms)
- Settings-like ~10k full scan was unsuitable for typeahead (p95 ~653 ms)
- Indexed Settings-like ~100k stayed tens of milliseconds; full-scan ranking of a high-DF query previously exhausted heap by retaining Θ(C²) pair diagnostics. 0.3.1 removes that allocation, packs remaining directed edges, and uses CSR + generation-stamp SCC ordering instead of JS adjacency/`Set` overlays. Comparison time remains Θ(C²) and is unsuitable for typeahead at 10k+; use `indexed` / `adaptive`.
- Article-like corpora crossed earlier because body/prefix hit sets explode

The inverted postings are relatively small. The **analyzed document store** (tokens, sets, copies) can dominate memory. That is a known limitation, not a ranking bug.

See [limitations.md](limitations.md).

## Future hybrid / semantic retrieval (contract only)

A query-semantic retriever is **not implemented**. If one is added, it must not reuse lexical analysis as the embed string.

A semantic retriever returns ordinary `RetrievalHit`-shaped candidates:

```js
{ document, retrievalSources: ["semantic"], retrievalScore?: number }
```

Union point: **after candidate retrieval, before `extractFeatures` / ranking feature extraction**. Lexical and semantic hits are then featured and ranked together.

Semantic query input:

- **Default:** the raw query string (`AnalyzedQuery.raw`)
- **Optional:** a join of repaired typed surfaces (`surfaceNormalized`)
- **Must never embed:** `query.tokens` after key projection, `token.normalized`, `token.lemma` after prefix completion, `completedToken`, `prefixCompletion.canonicalToken`, or `concepts.forms`

Lexical unique-prefix completion and configured-key projection rewrite retrieval identity. Those rewrites must not silently become the semantic query representation.

When a semantic similarity feature is added, introduce an explicit `semanticScore`. Do not overload lexical `retrievalScore` to smuggle semantic similarity into ranking.
