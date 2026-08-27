# Architecture

```text
search-core            src/                     platform-neutral runtime
search-browser         src/browser              Worker + latest-wins
search-corpus          tools/search-corpus      build-time corpus compiler
search-lexical         tools/search-lexical     lexical-frequency + lexical-index compilers
search-semantic        tools/search-semantic    optional Python relatedness builder
search-relationships   tools/search-relationships
```

Distribution: **one npm package** (`@software-land/search`) with subpath exports `.`, `./browser`, `./corpus`, `./relationships`, `./semantic`, and `./lexical`. Runtime and browser execute from emitted `dist/` JavaScript; root and browser public types are generated into `dist/*.d.ts`. Corpus, relationships, lexical, and Python semantic tooling remain source-shipped under `tools/`. Search Core and the browser Worker do not import `./semantic`, `./corpus`, `./relationships`, or `./lexical`. Application-owned model generation may supply external equivalence rows; the corpus compiler consumes them. The package does not own model execution.

Application relevance authoring is two primitives plus a separate generated graph. See [concepts.md](concepts.md):

- **Configured concepts** (`configuredConcepts`): which query forms mean the same configured concept. `aliases[0]` is canonical. This is not the corpus lexicon; term postings live in `lexicalIndex`.
- **Relationship map** (`relationshipMap`): which other forms, concepts, or documents are explicitly `equivalent` or `related`. Directional. No auto-reverse. No authored numeric weight.
- **Document relationships** (`documentRelationships`): compiled document-to-document `RelationshipArtifact` consumed by `SearchEngine.create`. Distinct from `relationshipMap`. Authored editorial edges come from `compileAuthoredRelevance()`.
- **Semantic graph**: generated document-to-document neighbors the model inferred. Not authored in `relationshipMap`. Merge onto `documentRelationships` with `mergeRelationships()`. Generated-edge rejection stays a separate follow-up.

## Environments

Tested: **Node 18+** (Jest/Node) and **in-process / loopback Worker semantics**. A real browser Worker uses the same protocol. Not promised: Deno, Bun, React Native, Android, Electron.

Search Core uses `performance.now` and `AbortSignal`. TypeScript ESM sources; Node/browser execute emitted `dist/` JavaScript. No `fs`, `process`, `Buffer`, or `Worker` in Core modules.

## Android / mobile

Architecture was validated against an Android Settings–style catalog. There is **no** native package. A future port would reimplement the algorithm/artifacts/retriever contract, not ship this JS as production Android.

## Public vs experimental

Public: `SearchEngine` facade, result fields above, artifact v1 envelopes, strategy names, retriever names, `AbortError`. `SearchEngine.create({ plugins })` is `SearchPlugin[]`. `compileAuthoredRelevance()` produces `DictionaryPlugin` and `SynonymPlugin` as implementation plugins inside `authored.plugins`. `morphology()` returns `EnglishPlugin`. Custom retrievers type as `ExperimentalRetriever`. Runtime still duck-types plugin objects and custom `retrieve` functions. These authoring contracts do not publish query-analysis or index internals; custom retriever `query` and `index` arguments stay `unknown`. There is no public `english()` or `dictionary()` root export.

Experimental / internal: custom Retriever objects, `retrievalScore` ranking weight, analyzed query objects, feature extraction, constraints module, `meta`, `lastSearchMeta`, `sourcePolicy`, BM25 constants, and lexical-index payload/posting internals. The opaque `search-v2-lexical-index` v1 envelope and compiler are public; its internal tuples and ordinals are not.

Query-semantic / vector retrieval is not implemented. If it is added, union semantic `RetrievalHit`s after lexical candidate retrieval and before feature extraction, embed the **raw query string** (optionally repaired typed surfaces), and never embed analyzed `query.tokens`, `normalized`, post-prefix `lemma`, `completedToken`, or `concepts.forms`. See [retrievers.md](retrievers.md).

Indexed search has been validated through about 100k documents on a VPN-like benchmark; roughly 50k–100k is the currently demonstrated practical range, not a correctness limit. Exact retrieval quality does not degrade with N, but query latency can still increase with competitive/conjunction cardinality, prefix expansion, feature work, artifact size, and browser memory. Stage 3A skips unread noncompetitive 1-of-k body postings on the supported exact multi-token path; remaining conjunction work is not flat with N. Stage 2C keeps compiled query state in packed token/offset views; see [compact-runtime.md](compact-runtime.md) and [scaling.md](scaling.md).
