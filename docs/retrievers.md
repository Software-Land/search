# Retrievers

v0 exposes **built-in names only**. A third-party `{ retrieve }` object is accepted as experimental and is not a stable contract (it sees internal query/index shapes). `searchAsync` calls `retrieveAsync` when present and otherwise `retrieve()`.

The public `retriever` field is `RetrieverName | "indexed-lexical" | ExperimentalRetriever`. `query` and `index` are intentionally `unknown`; those types do not publish `AnalyzedQuery`, `SearchIndex`, or `IndexedDocument`. Runtime still accepts a duck-typed `{ retrieve }` object.

```js
SearchEngine.create({
  retriever: "indexed",       // default: exact compiled lexical retrieval
  lexicalIndex,               // optional search-v2-lexical-index v1 artifact
  // retriever: "full-scan",
  // retriever: "adaptive",
  candidateLimit: 200,        // accepted for compatibility; not an exactness bound
  adaptive: { documentThreshold: 1500 },
});
```

| name | when |
| --- | --- |
| `indexed` | Default. Enumerates every legitimate match from a compiled positional lexical index, reconstructs the current exact features, and retains exact per-signature representatives. No posting pruning in v1. |
| `full-scan` | Explicit small-corpus / reference / debug mode. Scans every document. Does not apply `candidateLimit`. |
| `adaptive` | Full scan while `documentCount <= adaptive.documentThreshold`, else exact indexed retrieval. Deterministic. |

0.4.0 default retrieval is `indexed`. Its quality contract is equality with `full-scan`, not BM25 top-k recall. The old `candidateLimit = 200` setting is not the conceptual foundation of exact retrieval and cannot exclude a legitimate match. It remains accepted for API compatibility and experimental retrievers.

Explicit `full-scan`, `indexed`, `adaptive`, or a custom `ExperimentalRetriever` always wins over the default.

Default adaptive threshold **1500** is an adaptive-mode choice, not a correctness or candidate law.

## Compiled lexical index

`search-v2-lexical-index` version 1 contains deterministic document metadata, a sorted surface-term dictionary, title/body positional postings, one lemma per surface term, version/dotted-span metadata, corpus length statistics, and attached lexical-frequency data. It does not serialize raw body text.

Build it under the existing lexical package boundary:

```js
import { SearchEngine, morphology } from "@software-land/search";
import { compileLexicalIndex } from "@software-land/search/lexical";

const english = morphology({ lemmas });
const lexicalIndex = compileLexicalIndex(documents, {
  schema,
  lemma: english.lemma,
  analyzerId: english.indexIdentity,
});

const engine = SearchEngine.create({
  schema,
  plugins: [english],
  retriever: "indexed",
  lexicalIndex,
});
await engine.index(documents);
```

Identical inputs serialize byte-identically with `JSON.stringify`. A supplied artifact is checked for format/version, integrity, core analyzer identity, lemma identity, schema fields, document count, and a fingerprint of ids plus searchable title/body text and lexical-frequency data. An invalid supplied artifact throws; it is never ignored in favor of an approximate path.

If `lexicalIndex` is omitted, `index()` compiles the equivalent structure once from the supplied documents. This costs initialization time but not repeated query-time raw-field analysis. `retriever: "full-scan"` remains the explicit reference path.

## Exact matching and feature reconstruction

The compiled retriever performs exact surface, title/body, prefix, morphology, typo-alternative, configured-equivalence, version, dotted-span, and phrase-evidence behavior over the compiled statistics. It enumerates every legitimate matching document. v1 performs no WAND, MaxScore, block skipping, posting early termination, or prefix truncation.

With a supplied artifact, `searchDetailed().meta.rawDocumentScans` is `0`. Query-time feature work reads reconstructed indexed statistics rather than rescanning raw title/body strings. The fallback constructs those statistics during `index()`.

## Exact representative selection

For builtin constraints, candidates with the same exact constraint signature have identical relationships to every other signature. The sparse ranker orders members of one signature by rounded final `score`, then `document.id`. Therefore a candidate below depth R in its signature has R same-signature predecessors and cannot enter the global top R.

Proof sketch: let `~` be equality of the complete builtin signature. Every builtin constraint reads only signature fields, so `a ~ b` implies `compare(a, x) = compare(b, x)` and `compare(x, a) = compare(x, b)` for every candidate `x`. Thus `a` and `b` occupy the same signature node and SCC relationships, including conflicts and cycles. The ranker's only distinction inside that class is score/id. If `a` is below the first R members of its class, those R members have every predecessor/successor relationship that `a` has and are all ordered before it. At least R candidates therefore precede `a` globally, contradicting membership in the global top R. This argument does not assume an acyclic signature graph.

For ordinary non-explain output, the base per-signature depth is `max(limit, relatedLimit)`. Explain output needs the immediate global successor used by `constraintsVsNext`.

Relationship primary selection uses the same theorem over strong direct candidates: `top1-strong` needs one per signature and `top-n-strong` needs n; `all-strong` retains all. After expansion, public output has one further frozen requirement: every row exposes its absolute global `rank`. When a requested direct or related row lies deep in the global order, the engine retains a sufficient uniform signature prefix to preserve the complete global prefix through that row, plus its successor when explaining. This can make `representativeDepth` much larger than the public result limit.

`C` is the retained candidate count reported by `searchDetailed().meta.candidateCount`. For the simple path, `C <= B × representativeDepth`, where B is the number of exact signatures encountered; B has no fixed corpus-independent bound. Relationship rank preservation can increase the derived depth. Diagnostics are available under `meta.representativeSelection`.

Unknown/custom `ConstraintDef.fn` semantics are not covered by builtin signatures. The representative selector fails closed by retaining all candidates for the existing pairwise custom-constraint ranker.

## Scaling

Stage 1 is correctness-first and does Θ(matches) posting and feature work. High-DF queries can therefore still be expensive, but they no longer feed every match to the final sparse ranker when the representative theorem applies. The fixed candidate-200 architecture is intentionally gone. Conservative block pruning is future work and must preserve this exact path as its oracle.

BM25-like retrieval scores are diagnostic/admission-era data; their default final-ranking weight remains `0`. Representative selection uses the current final score and `document.id`, never BM25 admission rank.

Fixed-C ranker timings: [ranking envelope (GitHub tree; not in the npm tarball)](https://github.com/Software-Land/search/blob/main/benchmarks/ranking/README.md).

Builtin ranking is O(C log C + B²F + E_b) in the common case after selection and Θ(C²) in the worst case when B = C or constraints are custom. Do not claim a fixed hard C bound or a universal 5 ms high-DF target for Stage 1.

Allocation and RSS for the checked-in generators: [memory benchmarks (GitHub tree; not in the npm tarball)](https://github.com/Software-Land/search/blob/main/benchmarks/memory/README.md). That harness is not a latency or search-quality claim.

The v1 runtime currently reconstructs an object-heavy analyzed document view from the positional artifact so the frozen feature extractor remains unchanged. That duplicates some posting-derived information in memory; compact/lazy feature views are later optimization work, not part of Stage 1.

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
