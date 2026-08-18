# Architecture

```text
search-core            src/                     platform-neutral runtime
search-browser         src/browser              Worker + latest-wins
search-corpus          tools/search-corpus      build-time lexical compiler
search-semantic        tools/search-semantic    optional Python relatedness builder
search-relationships   tools/search-relationships
```

Distribution: **one npm package** for the JavaScript side (`software-land-search`) with subpath exports `.`, `./browser`, `./corpus`, and `./relationships`. Python semantic tooling lives in the same repository and is not part of the npm import graph.

## Environments

Tested: **Node 18+** (Jest/Node) and **in-process / loopback Worker semantics**. A real browser Worker uses the same protocol. Not promised: Deno, Bun, React Native, Android, Electron.

Search Core uses `performance.now`, `AbortSignal`, and ESM-syntax sources. No `fs`, `process`, `Buffer`, or `Worker` in Core modules.

## Android / mobile

Architecture was validated against an Android Settings–style catalog. There is **no** native package. A future port would reimplement the algorithm/artifacts/retriever contract, not ship this JS as production Android.

## Public vs experimental

Public: `SearchEngine` facade, result fields above, artifact v1, strategy names, retriever names, `AbortError`.

Experimental / internal: custom Retriever objects, `retrievalScore` ranking weight, analyzed query objects, feature extraction, constraints module, `meta`, `lastSearchMeta`, `sourcePolicy`, BM25 constants, lexical-index serialization (none).
