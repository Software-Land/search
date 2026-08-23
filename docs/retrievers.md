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

## Stage 1A: exact in-memory algorithm

The correctness proof is independent of serialization. With no artifact, `index()` first builds the existing `IndexedDocument` state and the exact retriever compiles its positional lookup once in memory. Query execution is:

1. enumerate every legitimate lexical match;
2. extract the unchanged complete feature vector, constraint signature, and rounded final score;
3. preserve the complete featured candidate map while choosing relationship primaries and applying target reclassification/addition;
4. feature newly added neighbors;
5. retain the exact required representatives per builtin signature;
6. run the unchanged sparse ranker.

Relationship primary reduction is temporary and does not remove entries from the map used for target handling. `top1-strong` uses depth one, `top-n-strong` uses the requested primary depth, and `all-strong` retains every eligible strong direct.

## Stage 1B: unified compiled analyzed index

`search-v2-lexical-index` version 1 is a unified positional representation: stable document ordinals and compact document-local metadata share one sorted surface-term dictionary and title/body positional streams. One deterministic lemma is stored per surface term, so lemma postings and hydrated lemma token sequences are derived without duplication. Version forms, dotted spans/components, first-token data, field lengths, and corpus length statistics complete the state needed by the frozen matcher and feature extractor.

The payload serializes neither raw title/body text nor per-document lexical-frequency maps. Validated caller documents continue to own display titles and the separate `search-v2-lexical-frequency` data. Positional streams hydrate the current `IndexedDocument` token arrays, sets, position maps, and exact retriever lookup; artifact load does not invoke tokenization, lemma analysis, or raw-document posting construction. After successful initialization the engine releases the validated envelope and document tuples, retaining only a small compatibility header, posting arrays, and hydrated runtime state. Re-indexing the same validated corpus reuses that state; incompatible replacement input rejects instead of silently rebuilding.

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

Identical inputs serialize byte-identically with `JSON.stringify`. A supplied artifact is checked for format/version, integrity, core analyzer identity, lemma identity, schema fields, document count, and a fingerprint of ids plus searchable title/body text and lexical-frequency data. An invalid supplied artifact throws; it is never ignored in favor of an approximate path. A custom lemma plugin without a deterministic `indexIdentity` remains valid for artifact-omitted runtime construction but is rejected when a supplied artifact cannot prove analyzer compatibility.

If `lexicalIndex` is omitted, `index()` compiles the equivalent structure once from the supplied documents. This costs initialization time but not repeated query-time raw-field analysis. `retriever: "full-scan"` remains the explicit reference path.

The v1 payload reserves an integrity-covered extension namespace keyed to stable term/document ordinals. Stage 1 emits it empty. A later exact block-bound capability can be added there without replacing the core positional representation; no block bounds or pruning behavior exist in Stage 1.

The rejected alternatives are:

- **Postings only:** smallest initial payload, but it still requires raw-document analysis to rebuild `IndexedDocument`, duplicates runtime posting ownership, and leaves Stage 2 without document-local positional bounds.
- **Postings plus a separate sufficient-statistics table:** avoids raw analysis, but duplicates term occurrences between posting and document streams and raises browser heap.
- **Unified analyzed index (selected):** one positional occurrence stream hydrates both document-local state and exact lookup. It has more load-time object hydration than a future typed-array view, but no raw lexical analysis and no redundant lexical-frequency ownership.

## Exact matching and feature reconstruction

The compiled retriever performs exact surface, title/body, prefix, morphology, typo-alternative, configured-equivalence, version, dotted-span, and phrase-evidence behavior over the compiled statistics. It enumerates every legitimate matching document. v1 performs no WAND, MaxScore, block skipping, posting early termination, or prefix truncation.

With a supplied artifact, `searchDetailed().meta.rawDocumentScans` is `0`. Query-time feature work reads reconstructed indexed statistics rather than rescanning raw title/body strings. The fallback constructs those statistics during `index()`.

## Exact representative selection

For builtin constraints, candidates with the same exact constraint signature have identical relationships to every other signature. The sparse ranker orders members of one signature by rounded final `score`, then `document.id`. Therefore a candidate below depth R in its signature has R same-signature predecessors and cannot enter the global top R.

Proof sketch: let `~` be equality of the complete builtin signature. Every builtin constraint reads only signature fields, so `a ~ b` implies `compare(a, x) = compare(b, x)` and `compare(x, a) = compare(x, b)` for every candidate `x`. Thus `a` and `b` occupy the same signature node and SCC relationships, including conflicts and cycles. The ranker's only distinction inside that class is score/id. If `a` is below the first R members of its class, those R members have every predecessor/successor relationship that `a` has and are all ordered before it. At least R candidates therefore precede `a` globally, contradicting membership in the global top R. This argument does not assume an acyclic signature graph.

The quotient is ordered: the sparse ranker discovers signature buckets in first-seen candidate order, and some deliberately directional builtin comparisons can be asymmetric for incoherent synthetic feature vectors. Representative selection therefore preserves first-seen signature order while sorting only within each bucket. Real SearchEngine candidates also share one query-derived `queryTokenCount`, but the ordering rule is retained and tested independently.

For ordinary non-explain output, the base per-signature depth is `max(limit, relatedLimit)`. Explain output needs the immediate global successor used by `constraintsVsNext`.

Relationship primary selection uses the same theorem over strong direct candidates: `top1-strong` needs one per signature and `top-n-strong` needs n; `all-strong` retains all. After expansion, public output has one further frozen requirement: every row exposes its absolute global `rank`. When a requested direct or related row lies deep in the global order, the engine retains a sufficient uniform signature prefix to preserve the complete global prefix through that row, plus its successor when explaining. This can make `representativeDepth` much larger than the public result limit.

For the normal `search()` and Worker result path, `C` is the retained candidate count reported by the path's diagnostics. For the simple path, `C <= B × representativeDepth`, where B is the number of exact signatures encountered; B has no fixed corpus-independent bound. Relationship rank preservation can increase the derived depth. The retained count is always available as `meta.representativeSelection.retained`.

Public `searchDetailed()` preserves the full-scan semantic diagnostics: absolute ranks, ordered `candidateTitles`, related count, cycle membership, conflict count, and the exact global successor used by `constraintsVsNext`. Stage 1 currently computes an exact full ranking plan for that diagnostic surface, then applies representative selection to the displayed result path. `search()`/`searchAsync()` and the Worker protocol do not depend on this diagnostic fallback; explain output still plans through every displayed row's exact successor. Reconstructing all diagnostics directly from signature cardinalities, SCC/DAG state, and ordered bucket streams is a later memory/latency optimization, not a weakened contract.

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
