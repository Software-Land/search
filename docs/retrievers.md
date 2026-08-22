# Retrievers

v0 exposes **built-in names only**. A third-party `{ retrieve }` object is accepted as experimental and is not a stable contract (it sees internal query/index shapes). `searchAsync` calls `retrieveAsync` when present and otherwise `retrieve()`.

The public `retriever` field is `RetrieverName | "indexed-lexical" | ExperimentalRetriever`. `query` and `index` are intentionally `unknown`; those types do not publish `AnalyzedQuery`, `SearchIndex`, or `IndexedDocument`. Runtime still accepts a duck-typed `{ retrieve }` object.

```js
SearchEngine.create({
  retriever: "indexed",     // default
  // retriever: "full-scan",
  // retriever: "adaptive",
  candidateLimit: 200,      // indexed budget for non-exact hits
  adaptive: { documentThreshold: 1500 },
});
```

| name | when |
| --- | --- |
| `indexed` | Default. Inverted lexical candidate generation, then the same exact match rules as full-scan. BM25 **orders the budgeted ordinary slice only**. |
| `full-scan` | Explicit small-corpus / reference / debug mode. Scans every document. Does not apply `candidateLimit`. |
| `adaptive` | Full scan while `documentCount <= adaptive.documentThreshold`, else indexed. Deterministic. No runtime benchmarking. |

0.4.0 default retrieval is `indexed`. That is a behavioral change even when Software.Land ordered results stay identical: large corpora no longer feature-extract and rank every lexical match.

Explicit `full-scan`, `indexed`, `adaptive`, or a custom `ExperimentalRetriever` always wins over the default.

Default adaptive threshold **1500** remains a documented fallback for the adaptive mode, not a new default policy. Settings-like and article-like corpora cross at different sizes. Benchmark unusual shapes. Do not treat 1500 as a derived cost/candidate law.

Must-keep union:

- `exact-title`, `configured-equivalence`, and `version` are **unbounded** deterministic must-keep.
- `contextual-title-prefix` is a **capped** must-keep (`prefixCap`, default 800), ranked by contextual quality then document position. Overflow is not dropped: it remains eligible for the ordinary `candidateLimit` pool, keeps `contextual-title-prefix` in `retrievalSources`, and competes by `retrievalScore` with deterministic pos tie-break.

Title-token / body / other prefix hits are budgeted by `candidateLimit`.

Synonym and typo alternatives are query-interpretation only. They become ordinary retrieval forms (budgeted unless they also qualify as a must-keep source).

`candidateLimit` default is 200. BM25 `k1`/`b` and title boost are implementation defaults, not public knobs.

## Candidate envelope

`C` is `searchDetailed().meta.candidateCount`: the featured set after retrieval **and** one-hop relationship expansion, immediately before ranking.

Let `k` be `candidateLimit` (default 200) and `P` the contextual-prefix-only hits.

Indexed retrieval:

```text
C_retrieve <= |U_exact ∪ U_equiv ∪ U_version| + min(|P|, prefixCap) + k
C        <= C_retrieve + |R_new|
```

`U_*` are documents whose retrieval sources include unbounded must-keep. `R_new` is one-hop neighbors of expansion primaries that were not already retrieved. Default `sourcePolicy` is `top1-strong` (one primary). Dedup is by document id before ranking.

Those `U_*` and `R_new` terms can grow with corpus size N when many documents share an exact title, a configured-equivalence title form, a version/dotted span, or a high-degree relationship neighborhood. 0.4.0 does **not** silently truncate those correctness-critical classes. Ordinary large-corpus operation is: index cheaply, apply the exact matcher to posting hits, budget the ordinary pool, then rank C. Builtin ranking is sparse in the number of constraint signatures; it is not a license to full-scan huge high-DF candidate sets.

Indexed posting hits are filtered through the same per-document match rules as full-scan before must-keep / `candidateLimit` assembly. Public `retrievalSources` are those exact names, not BM25 posting labels. Body prefix evidence uses `startsWith` at length ≥ 3, matching full-scan; it is not the stricter title `allowPrefixMatch` ratio.

On the 122-document Software.Land fixture, that exact matcher plus an ordinary budget of 200 (larger than any full-scan C on that corpus) reproduces the frozen 215-row ordered result oracle, the 98 strict contracts, and the 60 regressions, including query `"2"`. That is a quality-equivalence result for this corpus, not a claim that `C ≤ 200` on every query or that high-DF posting scans are free.

Full-scan does not apply `candidateLimit`. Matching documents can be Θ(N). It remains available as an explicit reference mode. Adaptive uses full-scan while `documentCount <= adaptive.documentThreshold` (default 1500), else indexed. Custom `{ retrieve }` objects are experimental and unbounded.

C becomes fixed in `SearchEngine._expandAndFeature` after related hits are appended, then `rankCandidates` / `rankCandidatesAsync` consume that array.

## BM25

Useful as a **candidate retriever**. Not the final relevance algorithm. Default ranking weight of any BM25 score is **0**. A non-zero weight helped one corpus shape and hurt another.

## Scaling

Small catalogs can remain interactive under either retriever. High-document-frequency **full-scan** at 10k+ candidates is unsuitable for typeahead and is not the 0.4.0 default. Builtin ranking is O(C log C + B²F + E_b) in the common case and Θ(C²) in the worst case (B = C or custom constraint functions). Corpus scale is a retrieval problem: default `indexed` keeps ordinary hits near `candidateLimit`. Full-scan of a high-DF term is not a large-C architecture. Do not claim a hard `C ≤ 200`, strict subquadratic worst case, or a 5 ms bound on all hardware.

Fixed-C ranker timings: [ranking envelope (GitHub tree; not in the npm tarball)](https://github.com/Software-Land/search/blob/main/benchmarks/ranking/README.md).

Full-scan ranking of a high-DF query previously exhausted heap by retaining Θ(C²) pair diagnostics. 0.3.1 no longer retains those objects, packs remaining directed edges, and uses CSR SCC traversal with generation-stamp component-edge deduplication instead of JS adjacency/`Set` overlays. 0.4.0 builtin ranking additionally avoids enumerating every candidate pair when signatures collapse. Article-like corpora can still cross the typeahead limit because body/prefix hit sets explode.

Allocation and RSS for the checked-in generators: [memory benchmarks (GitHub tree; not in the npm tarball)](https://github.com/Software-Land/search/blob/main/benchmarks/memory/README.md). That harness is not a latency or search-quality claim.

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
