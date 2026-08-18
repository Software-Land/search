# @software-land/search

Deterministic, explainable document search with optional offline corpus and semantic compilation. Ranking uses named features and partial-order constraints. Relatedness is a **build-time artifact**, not a runtime embedding model.

Copyright 2026 Sam Malayek. Licensed under Apache-2.0.

Source: [github.com/Software-Land/search](https://github.com/Software-Land/search). This tree is **0.x**.

## What it is

A JavaScript **runtime** that indexes documents, searches them, explains hits, and can attach a related-document rail from a compiled graph. It does not download models, call an LLM, or depend on a CMS.

**Zero production npm dependencies.** Node 18+.

Optional **offline compilers** (not required to search):

- `search-corpus` — lexical equivalences and synonyms from a portable `{id,title,body}` corpus
- `search-relationships` — editorial / semantic relationship graphs
- Python `tools/search-semantic` — optional relatedness builder in the **source repository only**, not in the npm tarball

Generated compiler candidates are review material. Only trusted compiled artifacts enter the runtime.

## Install

```bash
npm install @software-land/search
```

```js
import { SearchEngine, english, dictionary } from "@software-land/search";

const engine = SearchEngine.create({
  schema: {
    title: { type: "text", role: "title" },
    body: { type: "text", role: "body" },
  },
  plugins: [
    english(),
    dictionary({
      entries: [{ key: "wifi", expansion: ["wi", "fi"], aliases: [["wi", "fi"]] }],
    }),
  ],
});

await engine.index([
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
]);

engine.search("wireless");
```

`wifi` as a single token does not match the title `Wi-Fi` unless you configure an alias. That is corpus configuration, not a Core heuristic.

## Browser Worker

Optional. Core does not import `Worker` or `window`.

```js
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const client = createSearchClient({
  workerUrl: searchWorkerUrl(),
  onResult({ query, result }) { /* render */ },
});

await client.init({ documents, schema, retriever: "adaptive" });
client.setQuery("bluetooth");
client.dispose();
```

`searchWorkerUrl()` resolves the bundled Worker **from this package** (`import.meta.url` of the browser entry). Consumers should not build a Worker URL against their own module; that would miss `searchWorker.js`. Omitting `workerUrl` uses the same default.

Protocol is plain `postMessage`. Latest-wins: a new query replaces pending work and cancels stale running searches.

## Corpus compiler

Node CLI. Search Core never imports this tool.

```bash
node tools/search-corpus/build.mjs analyze --input corpus.json --output dir
node tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions decisions.json
```

```js
import { compileCorpus } from "@software-land/search/corpus";

const { equivalences, synonyms, dictionaryEntries } = compileCorpus({
  documents: [{ id: "a", title: "Central Processing Unit (CPU)", body: "The CPU fetches instructions." }],
});
```

## Relationship compiler

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json --decisions decisions.json \
  --semantic relationships-from-builder.json --output dir
```

```js
import { compileRelationships } from "@software-land/search/relationships";
```

## Optional semantic compiler (Python)

Lives in the GitHub/source tree. **Not packed to npm.** Lexical relatedness uses the Python standard library. Embedding extras are optional:

```bash
python3 -m venv tools/search-semantic/.venv
tools/search-semantic/.venv/bin/pip install -r tools/search-semantic/requirements-embed.txt
python3 tools/search-semantic/build.py --input corpus.json --method lexical --output graph.json
```

Default embedding model (when requested): `sentence-transformers/all-MiniLM-L6-v2`. Weights are downloaded into `.cache/` and are not redistributed. See `tools/search-semantic/LICENSES.md`.

## Artifact flow

```text
corpus JSON
  → search-corpus          → equivalences.json + synonyms.json
  → search-semantic (opt.) → relationships (semantic)
  → search-relationships   → search-v2-relationships v1
  → SearchEngine.create({ dictionary entries, relationships })
```

Runtime parsers: `parseEquivalences`, `parseSynonyms`, `parseRelationships`. Artifact `format` + `version` are part of the public contract.

## TypeScript

Implementation is JavaScript. Public types ship as `.d.ts` (`types` on each export). From a git checkout:

```bash
npm run typecheck
```

`allowJs` / `checkJs` / `strict` / `noImplicitAny` / `noEmit`. Python is outside `tsc`. Typecheck configs are not in the npm tarball; consumers use the shipped `.d.ts` files.

## API stability

v0 (`0.1.0`). The runtime facade, result shape, artifact `format`+`version`, `relationshipStrategy` values, and retriever names are intended to stabilize. Internal feature vectors, BM25 constants, and ranking modules are not public exports.

Supported imports: `@software-land/search`, `@software-land/search/browser`, `@software-land/search/corpus`, `@software-land/search/relationships`.

Root exports: `SearchEngine`, `english`, `dictionary`, strategy/retriever constants, artifact parsers, abort helpers, public error classes. `searchWorkerUrl()` is exported only from `./browser`.

## Docs

| Topic | File |
| --- | --- |
| Concepts | [docs/concepts.md](docs/concepts.md) |
| Schema / documents | [docs/schema.md](docs/schema.md) |
| Search API | [docs/api.md](docs/api.md) |
| Explanations | [docs/explanations.md](docs/explanations.md) |
| Retrievers / scaling | [docs/retrievers.md](docs/retrievers.md) |
| Relationships | [docs/relationships.md](docs/relationships.md) |
| Artifacts | [docs/artifacts.md](docs/artifacts.md) |
| Build-time tools | [docs/tooling.md](docs/tooling.md) |
| Browser Worker | [docs/browser.md](docs/browser.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Known limitations | [docs/limitations.md](docs/limitations.md) |

## License

Copyright 2026 Sam Malayek.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
