# Architecture

```text
search-core            src/                     platform-neutral runtime
search-browser         src/browser              Worker + latest-wins
search-corpus          tools/search-corpus      build-time corpus compiler
search-lexical         tools/search-lexical     lexical-frequency + lexical-index compilers
search-semantic        tools/search-semantic    optional Python relatedness builder
search-relationships   tools/search-relationships
```

Distribution: **one npm package** (`@software-land/search`) with subpath exports `.`, `./browser`, `./corpus`, `./relationships`, `./semantic`, and `./lexical`. Runtime and browser execute from emitted `dist/` JavaScript; root and browser public types are generated into `dist/*.d.ts`. Corpus, relationships, lexical, and Python semantic tooling remain source-shipped under `tools/`. Search Core and the browser Worker do not import `./semantic`, `./corpus`, or `./relationships`.

## Environments

Tested: **Node 18+** (Jest/Node) and **in-process / loopback Worker semantics**. A real browser Worker uses the same protocol. Not promised: Deno, Bun, React Native, Android, Electron.

Search Core uses `performance.now` and `AbortSignal`. TypeScript ESM sources; Node/browser execute emitted `dist/` JavaScript. No `fs`, `process`, `Buffer`, or `Worker` in Core modules.

## Android / mobile

Architecture was validated against an Android Settings–style catalog. There is **no** native package. A future port would reimplement the algorithm/artifacts/retriever contract, not ship this JS as production Android.

## Public vs experimental

Public: `SearchEngine` facade, result fields above, artifact v1 envelopes, strategy names, retriever names, `AbortError`. `SearchEngine.create({ plugins })` is `SearchPlugin[]`. `dictionary()` returns `DictionaryPlugin`. `morphology()` returns `EnglishPlugin`. Custom retrievers type as `ExperimentalRetriever`. Runtime still duck-types plugin objects and custom `retrieve` functions. These authoring contracts do not publish query-analysis or index internals; custom retriever `query` and `index` arguments stay `unknown`. There is no public `english()` root export.

Experimental / internal: custom Retriever objects, `retrievalScore` ranking weight, analyzed query objects, feature extraction, constraints module, `meta`, `lastSearchMeta`, `sourcePolicy`, BM25 constants, and lexical-index payload/posting internals. The opaque `search-v2-lexical-index` v1 envelope and compiler are public; its internal tuples and ordinals are not.

Query-semantic / vector retrieval is not implemented. If it is added, union semantic `RetrievalHit`s after lexical candidate retrieval and before feature extraction, embed the **raw query string** (optionally repaired typed surfaces), and never embed analyzed `query.tokens`, `normalized`, post-prefix `lemma`, `completedToken`, or `concepts.forms`. See [retrievers.md](retrievers.md).

Current practical browser scale is an engineering target of about 10k–25k documents, not a correctness limit. Exact retrieval quality does not degrade with N; posting work, feature work, artifact/load cost, and browser memory do. Stage 2C keeps compiled query state in packed token/offset views; see [compact-runtime.md](compact-runtime.md) and [scaling.md](scaling.md).
