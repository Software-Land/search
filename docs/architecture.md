# Architecture

```text
search-core            src/                     platform-neutral runtime
search-browser         src/browser              Worker + latest-wins
search-corpus          tools/search-corpus      build-time lexical compiler
search-semantic        tools/search-semantic    optional Python relatedness builder
search-relationships   tools/search-relationships
```

Distribution: **one npm package** (`@software-land/search`) with subpath exports `.`, `./browser`, `./corpus`, `./relationships`, `./semantic`, and `./lexical`. Runtime and browser execute from emitted `dist/` JavaScript; root and browser public types are generated into `dist/*.d.ts`. Corpus, relationships, lexical, and Python semantic tooling remain source-shipped under `tools/`. Search Core and the browser Worker do not import `./semantic`, `./corpus`, or `./relationships`.

## Environments

Tested: **Node 18+** (Jest/Node) and **in-process / loopback Worker semantics**. A real browser Worker uses the same protocol. Not promised: Deno, Bun, React Native, Android, Electron.

Search Core uses `performance.now`, `AbortSignal`, and ESM-syntax sources. No `fs`, `process`, `Buffer`, or `Worker` in Core modules.

## Android / mobile

Architecture was validated against an Android Settings–style catalog. There is **no** native package. A future port would reimplement the algorithm/artifacts/retriever contract, not ship this JS as production Android.

## Public vs experimental

Public: `SearchEngine` facade, result fields above, artifact v1, strategy names, retriever names, `AbortError`. Opt-in type-only plugin/retriever authoring contracts (`SearchPlugin`, `ExperimentalRetriever`, …) do not narrow create() inputs and do not publish analysis or index internals.

Experimental / internal: custom Retriever objects, `retrievalScore` ranking weight, analyzed query objects, feature extraction, constraints module, `meta`, `lastSearchMeta`, `sourcePolicy`, BM25 constants, lexical-index serialization (none).

Query-semantic / vector retrieval is not implemented. If it is added, union semantic `RetrievalHit`s after lexical candidate retrieval and before feature extraction, embed the **raw query string** (optionally repaired typed surfaces), and never embed analyzed `query.tokens`, `normalized`, post-prefix `lemma`, `completedToken`, or `concepts.forms`. See [retrievers.md](retrievers.md).
