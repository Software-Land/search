# Architecture

```text
search-core            src/                     platform-neutral runtime
search-browser         src/browser              Worker + latest-wins
search-corpus          tools/search-corpus      build-time corpus compiler
search-lexical         tools/search-lexical     lexical-frequency + lexical-index compilers
search-semantic        tools/search-semantic    optional Python relatedness builder
search-relationships   tools/search-relationships
```

Search Core source layout:

```text
src/
  index.ts  api.ts  SearchEngine.ts  config.ts  morphology.ts
  types.d.ts  ambient-core.d.ts
  cancel.ts  errors.ts  artifacts.ts  evidencePolicy.ts
  documentId.ts  saturatingFrequency.ts  stableHash.ts
  text/            tokenize / lexical normalize / version forms / english
  query/           analyze, query semantics, configured sequence, query plan
  indexing/        documents, compact store, lexical index, positional index
  retrieval/       retrieve, retrievers, positional queries, Stage 3A
  features/        FeatureVector extraction and empty-feature defaults
  ranking/         constraint ranker; evidence/ is packed ranking evidence
  execution/       session capability facts, complete-interpretation collector
  results/         explanation and public result assembly
  relationships/   runtime graph, authored map, configured-concept compiler
  browser/         Worker + latest-wins
```

Distribution: **one npm package** (`@software-land/search`) with subpath exports `.`, `./browser`, `./corpus`, `./relationships`, `./semantic`, and `./lexical`. Runtime and browser execute from emitted `dist/` JavaScript; root and browser public types are generated into `dist/*.d.ts`. Internal `dist/` module paths are not a public API; they follow the `src/` tree and may move. Corpus, relationships, lexical, and Python semantic tooling remain source-shipped under `tools/`. Search Core and the browser Worker do not import the package tooling subpaths `@software-land/search/semantic`, `@software-land/search/corpus`, `@software-land/search/relationships`, or `@software-land/search/lexical`. Application-owned model generation may supply externally generated configured-concept rows; the corpus compiler consumes them. The package does not own model execution.

Application relevance authoring is two primitives plus a separate generated graph. See [concepts.md](concepts.md):

- **Configured concepts** (`configuredConcepts`): which query forms mean the same configured concept. Aliases are unordered peers. This is not the corpus lexicon; term postings live in `lexicalIndex`.
- **Relationship map** (`relationshipMap`): which other forms, concepts, or documents are explicitly `equivalent` or `related`. Directional. No auto-reverse. No authored numeric weight.
- **Document relationships** (`documentRelationships`): compiled document-to-document `RelationshipArtifact` consumed by `SearchEngine.create`. Distinct from `relationshipMap`. Authored editorial edges come from `compileAuthoredRelevance()`.
- **Semantic graph**: generated document-to-document neighbors the model inferred. Not authored in `relationshipMap`. Merge onto `documentRelationships` with `mergeRelationships()`. Generated-edge rejection stays a separate follow-up.

## Environments

Tested: **Node 18+** (Jest/Node) and **in-process / loopback Worker semantics**. A real browser Worker uses the same protocol. Not promised: Deno, Bun, React Native, Android, Electron.

Search Core uses `performance.now` and `AbortSignal`. TypeScript ESM sources; Node/browser execute emitted `dist/` JavaScript. No `fs`, `process`, `Buffer`, or `Worker` in Core modules.

## Android / mobile

Architecture was validated against an Android Settings–style catalog. There is **no** native package. A future port would reimplement the algorithm/artifacts/retriever contract, not ship this JS as production Android.

## Public vs experimental

Public: `SearchEngine` facade, result fields above, artifact v1 envelopes, strategy names, retriever names, `AbortError`. `SearchEngine.create({ plugins })` is `SearchPlugin[]`. `compileAuthoredRelevance()` returns the ordered `SearchPlugin[]` needed for configured-concept recognition and authored relevance. `morphology()` returns `EnglishPlugin`. Custom retrievers type as `ExperimentalRetriever`. Runtime still duck-types plugin objects and custom `retrieve` functions. These authoring contracts do not publish query-analysis or index internals; custom retriever `query` and `index` arguments stay `unknown`. Custom `SearchPlugin` hooks are `lemma`, `canonicalLemma`, and `lexicon`. `lemma` is morphological equivalence and lemma-only forms are exact-only for ordinary lexical prefix matching; `canonicalLemma` is authoritative normalization with ordinary prefix semantics. Compiled configured-concept internals and compiled related-recall tables are not public `SearchPlugin` fields; author `configuredConcepts` / `relationshipMap` and compile with `compileAuthoredRelevance()`. There is no public `english()` or `dictionary()` root export.

Experimental / internal: custom Retriever objects, `retrievalScore` ranking weight, analyzed query objects, feature extraction, constraints module, `meta`, `lastSearchMeta`, `sourcePolicy`, BM25 constants, and lexical-index payload/posting internals. The opaque `search-v2-lexical-index` v1 envelope and compiler are public; its internal tuples and ordinals are not.

Query-semantic / vector retrieval is not implemented. If it is added, union semantic `RetrievalHit`s after lexical candidate retrieval and before ranking-feature materialization, embed the **raw query string** (optionally repaired typed surfaces), and never embed analyzed `query.tokens`, `normalized`, post-prefix `lemma`, `completedToken`, or `concepts.forms`. See [retrievers.md](retrievers.md).

## Query execution

Public ranking semantics are unchanged. FeatureVector is no longer the mandatory internal representation for every direct candidate.

Eligible ordinary `search()` / `searchAsync()` (default hybrid included):

```text
analyze / query plan
  → compiled retrieval + fused exact ranking evidence
  → exact numeric finalization / packed direct views
  → existing builtin selection / constraint ranking
  → existing relationship expansion
  → public results
```

Diagnostic / fallback (`searchDetailed()`, `explain: true`, exhaustive diagnostics, complete-interpretation, custom retrievers, unsupported query shapes):

```text
retrieve
  → FeatureVector extraction
  → existing builtin selection / constraint ranking
  → existing relationship expansion
  → public results
```

Fallback is exact, not a quality degradation. There is no public optimization toggle. Stage 3A retrieval pruning and ranking-evidence fusion (shipped in 0.6.5) are separate layers; see [exact-pruning.md](exact-pruning.md) and [scaling.md](scaling.md).

Indexed search has been validated through about 100k documents on mixed and VPN-like workloads; roughly 50k–100k is the currently demonstrated practical range, not a correctness limit. Exact retrieval quality does not degrade with N, but query latency can still increase with competitive/conjunction cardinality, prefix expansion, posting work, artifact size, and browser memory. Stage 3A skips unread noncompetitive 1-of-k body postings on the supported exact multi-token path; remaining conjunction work is not flat with N. Stage 2C keeps compiled query state in packed token/offset views. Million-document ordinary search under 50 ms is not current capability. See [compact-runtime.md](compact-runtime.md) and [scaling.md](scaling.md).

## Internal ownership

Downstream presence/identity questions consume a canonical query-semantic fact projection. Analyzer payloads such as spans, completion, recall pairs/forms, phrase keys, and diagnostic representation remain on the analyzed query.

Session/capability facts are projected separately from eligibility policy. Stage 3A, Stage 2A feature-block pruning, packed ranking-evidence eligibility, packed-search fallback, and complete-interpretation remain independent policies.

`SearchEngine` prepares the query, chooses packed or FeatureVector execution, retrieves/evaluates, ranks/selects, expands relationships, and captures timings. Packed and FeatureVector evaluators remain distinct. Shared empty/default semantics and packed encodings are not a second ranking model.
