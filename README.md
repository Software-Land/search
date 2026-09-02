# @software-land/search

Deterministic, explainable document search with optional offline corpus and semantic compilation. Ranking uses named features and partial-order constraints. Relatedness is a **build-time artifact**, not a runtime embedding model.

Copyright 2026 Software.Land. Versions 0.5.0 and later are source-available under Business Source License 1.1.

Source: [github.com/Software-Land/search](https://github.com/Software-Land/search). This tree is **0.x**.

## What it is

A JavaScript **runtime** that indexes documents, searches them, explains hits, and can attach a related-document rail from a compiled graph. It does not download models, call an LLM, or depend on a CMS.

Default **indexed** retrieval is exact: it preserves the same result semantics as exhaustive compiled retrieval. Pass `retriever: "full-scan"` only as an explicit reference mode. Scaling, compact runtime, and fail-closed pruning are documented in [docs/retrievers.md](docs/retrievers.md), [docs/exact-pruning.md](docs/exact-pruning.md), and [docs/scaling.md](docs/scaling.md).

**Zero production npm dependencies.** Node 18+.

Optional **build-time compilers** are not imported by the runtime. They live on package subpaths (`./lexical`, `./corpus`, `./relationships`, `./semantic`). Generated compiler candidates are review material. Only trusted compiled artifacts and authored configuration enter the runtime.

## Install

```bash
npm install @software-land/search
```

## Build time vs runtime

Substantial corpus analysis can happen **offline**. Query-time search consumes a hydrated in-memory representation. Precompilation is not required; omitting a lexical index is a supported, exact path that does the same analysis during `index()`.

```text
documents
   │
   ├─ optional ranking evidence (attach before lexical compile if used):
   │          compileLexicalFrequency(...)
   │                ↓
   │          attachLexicalFrequency(documents, artifact)
   │                ↓
   │          those documents feed compileLexicalIndex and runtime index()
   │
   ├─ typical when avoiding init-time corpus analysis:
   │          compileLexicalIndex(documents, { schema, lemma, analyzerId })
   │                ↓
   │          persist JSON (search-v2-lexical-index v1)
   │
   ├─ optional concept/form layer:
   │          authored JSON, and/or compileCorpus(...)
   │                ↓
   │          configuredConcepts, relationshipMap
   │
   ├─ optional document-graph layer:
   │          compileSemantic(...) and/or compileRelationships(...)
   │                ↓
   │          documentRelationships (optionally mergeRelationships(...))
   ▼
deployment (artifacts + fingerprint-matching documents)
   ▼
compileAuthoredRelevance({ configuredConcepts, relationshipMap }) → plugins
SearchEngine.create({ schema, plugins, lexicalIndex?, documentRelationships? })
await engine.index(documents)
   ▼
engine.search(...)
```

**Build time** may compile the positional lexical index with the same `schema` and morphology/lemma identity used at search time; optionally compile lexical-frequency maps and attach them to documents **before** that compile; optionally review corpus-mined concepts into `configuredConcepts` / `relationshipMap`; and optionally compile a document-to-document graph. Persist ordinary JSON; Search Core does not dictate files, bundlers, or object storage. Fingerprint-matching documents means stable ids, title/body text, and any attached `lexicalFrequency` maps.

**Runtime initialization** creates morphology and other plugins, compiles authored relevance from trusted JSON (`compileAuthoredRelevance` returns runtime plugin objects, not a second JSON format; `configuredConcepts` and `relationshipMap` are not `SearchEngine.create` options), creates the engine, and calls `index(documents)`. With a supplied `lexicalIndex`, that call validates and hydrates. With the artifact omitted, it constructs equivalent lexical state from the documents.

**Query time** searches the already-hydrated compact/indexed representation. The indexed path does not rescan or retokenize raw title/body text. Details: [docs/compact-runtime.md](docs/compact-runtime.md).

## Runtime construction

Omitting `lexicalIndex` is supported and exact. `index(documents)` constructs equivalent lexical state during initialization. That is convenient for small catalogs, tests, and first integration. It performs title/body lexical analysis at init; it is not a different or approximate query algorithm.

```js
import { SearchEngine, morphology, compileAuthoredRelevance } from "@software-land/search";

const authored = compileAuthoredRelevance({
  configuredConcepts: [{ key: "wifi", aliases: [["wi", "fi"]] }],
});

const engine = SearchEngine.create({
  schema: {
    title: { type: "text", role: "title" },
    summary: { type: "text", role: "summary" },
    body: { type: "text", role: "body" },
  },
  plugins: [
    morphology(),
    ...authored.plugins,
  ],
});

await engine.index([
  { id: "wifi", title: "Wi-Fi", summary: "Connect to wireless networks.", body: "Full article text." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
]);

engine.search("wireless");
```

Optional schema role `"summary"` is short authored summary or search-description text, distinct from `body`. Omit the role (and the field) to keep the title/body contract. Summary is **not** a third ordinary unigram posting field: candidate generation stays title/body-only. Summary may contribute positional phrase hits, configured-concept field evidence, typed-phrase ranking features, and the optional complete-interpretation collector. Details: [docs/schema.md](docs/schema.md).

`wifi` as a single token does not match the title `Wi-Fi` unless you configure an alias. That is corpus configuration, not a Core heuristic.

## Precompiled lexical index

When init-time corpus analysis should be avoided, compile the positional index in a build step and pass it into `SearchEngine.create({ lexicalIndex })`. Default retrieval is already `"indexed"`; you do not need to set `retriever` for this path.

The artifact is ordinary JSON-serializable data (`search-v2-lexical-index` version 1). Search Core does not read the filesystem. `writeFile` / `readFile` below are illustrative; a static import, `fetch`, bundler asset, or object-storage read is equally valid.

Use the same `schema` and the same `morphology({ lemmas })` (or `morphology()`) at compile time and at search time. `compileLexicalIndex` requires `analyzerId` whenever `lemma` is supplied; pass `morphology(...).indexIdentity`.

```js
import { writeFile } from "node:fs/promises";
import { morphology } from "@software-land/search";
import { compileLexicalIndex } from "@software-land/search/lexical";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const lemmas = {}; // optional site map; must match search time
const documents = [
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
];
const english = morphology({ lemmas });
const lexicalIndex = compileLexicalIndex(documents, {
  schema,
  lemma: english.lemma,
  analyzerId: english.indexIdentity,
});

await writeFile("search-lexical-index.json", JSON.stringify(lexicalIndex));
```

```js
import { readFile } from "node:fs/promises";
import { SearchEngine, morphology } from "@software-land/search";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const lemmas = {}; // same map as compile time
const documents = [
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
];
const english = morphology({ lemmas });
const lexicalIndex = JSON.parse(await readFile("search-lexical-index.json", "utf8"));

const engine = SearchEngine.create({
  schema,
  plugins: [english],
  lexicalIndex,
});

await engine.index(documents);
engine.search("wireless");
```

`documents` at runtime must be the same corpus the artifact was compiled from (stable ids, title/body text, and any attached lexical-frequency maps). Optional `summary` is not stored in the v1 title/body postings; `index()` hydrates summary state from the caller documents. See [docs/artifacts.md](docs/artifacts.md) and [docs/schema.md](docs/schema.md).

A supplied incompatible or corrupt artifact **throws**. The engine does not ignore it and rebuild from raw documents. If `lexicalIndex` is omitted instead, each `index()` call constructs equivalent state from `documents`.

After `index()` resolves, the engine has released its reference to the artifact envelope. The caller may drop its own copy. A later identical `index()` reuses the hydrated state; incompatible replacement documents reject.

### Why `index(documents)` is still required

The lexical artifact is the compiled search representation. The documents remain the runtime source of document data and are used to validate and hydrate that representation.

With a supplied `lexicalIndex`, `await engine.index(documents)` does **not** rebuild precompiled title/body postings. It:

- validates artifact `format` / `version`, integrity, schema title/body field names, analyzer identity, and the corpus fingerprint
- hydrates compact query-time state from the artifact
- uses caller documents for display titles, optional summary text, and attached `lexicalFrequency` maps when present

Searching before `index()` throws. Details: [docs/retrievers.md](docs/retrievers.md), [docs/artifacts.md](docs/artifacts.md).

## Compatibility

A supplied lexical index is tied to the data and analyzer used to build it. Rebuild it when document ids, title/body text, schema title/body roles, morphology / lemma identity, or attached lexical-frequency maps change. Mismatches fail closed.

Optional `summary` is not part of the v1 serialized title/body corpus fingerprint, so a summary-only edit does not require rebuilding the lexical artifact. Summary state is hydrated from the documents on a new engine's first `index()`; after that, changing summary data requires creating a new engine with the same lexical artifact rather than re-indexing the existing engine. See [docs/artifacts.md](docs/artifacts.md).

Rebuild authored configuration when `configuredConcepts` or `relationshipMap` change, and rebuild relationship graphs when semantic or editorial edges change. Those are separate artifacts from the lexical index.

## Browser Worker

Optional. Core does not import `Worker` or `window`. The same precompiled `lexicalIndex` JSON can be passed into the Worker.

```js
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const client = createSearchClient({
  workerUrl: searchWorkerUrl(),
  onResult({ query, result }) { /* render */ },
});

await client.init({
  documents,
  schema,
  lexicalIndex,
  configuredConcepts,
  relationshipMap,
  documentRelationships,
  englishOptions: { lemmas }, // same map used at compileLexicalIndex, if any
});
client.setQuery("bluetooth");
client.dispose();
```

`searchWorkerUrl()` resolves the bundled Worker **from this package** (`import.meta.url` of the browser entry). Consumers should not build a Worker URL against their own module; that would miss `searchWorker.js`. Omitting `workerUrl` uses the same default.

Omit `lexicalIndex` to construct equivalent lexical state once during Worker initialization (the same runtime-construction path as in-process). A supplied invalid artifact rejects initialization.

`configuredConcepts` and `relationshipMap` are JSON configuration. The Worker compiles authored relevance from them; do not send plugin functions. If the lexical index was compiled with a custom lemma map, pass that same map as `englishOptions.lemmas`.

After the Worker reports ready, the page does not need to retain the lexical artifact solely for the Worker. Search options such as `resultCollector` belong on `setQuery`, not `init`. Protocol, latest-wins cancellation, and message shapes: [docs/browser.md](docs/browser.md).

## Authored relevance

Applications author `configuredConcepts` and a directional `relationshipMap` as JSON (or equivalent in-memory objects). `compileAuthoredRelevance()` turns that trusted configuration into **runtime plugin objects** plus optional authored document relationships. Persist the JSON configuration; do not persist `authored.plugins`.

```js
import { SearchEngine, morphology, compileAuthoredRelevance } from "@software-land/search";

const configuredConcepts = [{ key: "qa", aliases: [["quality", "assurance"]] }];
const relationshipMap = {
  qa: [{ to: { form: "testing" }, kind: "equivalent" }],
  docker: [{ to: { form: "container" }, kind: "equivalent" }],
};

const authored = compileAuthoredRelevance({
  configuredConcepts,
  relationshipMap,
});

const engine = SearchEngine.create({
  schema: {
    title: { type: "text", role: "title" },
    body: { type: "text", role: "body" },
  },
  plugins: [
    morphology(),
    ...authored.plugins,
  ],
  documentRelationships: authored.documentRelationships,
});
```

Pass `documents` into `compileAuthoredRelevance` when `relationshipMap` has document endpoints that must resolve against ids or titles.

Search data is four distinct layers:

| Name | Meaning |
| --- | --- |
| `configuredConcepts` | authored concepts `{ key, aliases }` |
| `lexicalIndex` | corpus lexical term/posting index |
| `relationshipMap` | authored form/concept/document relevance |
| `documentRelationships` | compiled document-to-document graph |

`configuredConcepts` is not the corpus lexicon; term postings live in `lexicalIndex`.

`authored.plugins` is the compiler-owned plugin list: configured-concept recognition (including related standalone/topical recall) followed by compiled equivalent one-hop recall. Ordinary applications do not assemble those pieces by name. `equivalent` edges are directional and do not auto-reverse. `qa → testing` does not imply `testing → qa`. When equivalence is symmetric, author both directions. Trusted corpus-mined accepted groups do this automatically by compiling each group into a bidirectional equivalent clique. Phrase sources match as exact contiguous normalized phrases.

`authored.documentRelationships` is the editorial document→document artifact, or `null` when none were authored. Combine it with a generated semantic artifact using `mergeRelationships(semantic, authored.documentRelationships)`.

Complete authored relevance — equivalent recall, related standalone/topical forms, and editorial document edges — uses `compileAuthoredRelevance()`.

## Optional lexical frequency

`compileLexicalFrequency` is **not** an alternative retrieval index and is not a `SearchEngine.create` option. It is optional body n-gram evidence used at ranking time (`bodyPhraseCount`). Search remains correct without it; missing maps score as zero phrase counts.

```js
import { morphology } from "@software-land/search";
import { compileLexicalFrequency, attachLexicalFrequency } from "@software-land/search/lexical";

const english = morphology(); // same lemma/analyzer as compileLexicalIndex
const frequency = compileLexicalFrequency(documents, { lemma: english.lemma });
const documentsWithFrequency = attachLexicalFrequency(documents, frequency);
```

If you use frequency maps, attach them **before** `compileLexicalIndex`, and attach the same maps to the documents passed to runtime `index()`, so the lexical-index fingerprint agrees. Policy details: [docs/tooling.md](docs/tooling.md).

## Corpus compiler

Optional. Search Core never imports this tool. It mines **candidates** from `{id,title,body}` documents. Those candidates are not runtime policy until they pass the compiler’s trusted lifecycle (auto-accepted or human-accepted decisions).

```text
corpus analysis
  → generated candidates
  → review / decisions
  → trusted configuredConcepts + relationshipMap
  → compileAuthoredRelevance(...)
```

Public JavaScript API:

```js
import { compileCorpus, reconcileExternalConfiguredConcepts } from "@software-land/search/corpus";

const { configuredConcepts, relationshipMap } = compileCorpus({
  documents: [{ id: "a", title: "Central Processing Unit (CPU)", body: "The CPU fetches instructions." }],
});

const generated = reconcileExternalConfiguredConcepts([
  { key: "cpu", aliases: [["central", "processing", "unit"]] },
]);
void generated.configuredConcepts;
```

`compileCorpus()` returns only currently trusted rows. Unreviewed synonym groups do not become `relationshipMap` equivalent edges. For analyze → durable `decisions.json` → compile, use the shipped CLI (there is no package `bin` entry):

```bash
node node_modules/@software-land/search/tools/search-corpus/build.mjs analyze --input corpus.json --output dir
node node_modules/@software-land/search/tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions decisions.json
```

From a git checkout of this repository the same scripts are `tools/search-corpus/build.mjs`. Workflow: [docs/tooling.md](docs/tooling.md).

## Relationship and semantic compilation

Optional document-to-document graphs. Search Core never imports these tools.

```js
import { compileRelationships } from "@software-land/search/relationships";
import { compileSemantic } from "@software-land/search/semantic";

const { artifact } = await compileSemantic(corpusJson, {
  method: "embedding",
  representation: "title_struct",
  topK: 5,
  minScore: 0.3,
  precisionGate: true,
  mutual: true,
});
```

When `outputPath` is omitted, `compileSemantic()` still writes a unique file under the system temp directory and returns that path. The file survives the call. The caller owns it and may remove it when finished. Pass `outputPath` to choose a durable location.

Lexical relatedness uses the Python standard library. Embedding extras are installed into an isolated venv on first `combined` / `embedding` compile. Default embedding model (when requested): `sentence-transformers/all-MiniLM-L6-v2`. Weights are downloaded into a builder cache and are not redistributed. See `tools/search-semantic/LICENSES.md`.

Shipped CLIs (no package `bin`; from an npm install):

```bash
node node_modules/@software-land/search/tools/search-relationships/build.mjs compile \
  --input corpus.json --domain domain.json \
  --semantic relationships-from-builder.json --output dir

node node_modules/@software-land/search/tools/search-semantic/build.mjs \
  --input corpus.json --output graph.json --method embedding --precision-gate --mutual
```

Merge generated semantic edges with authored editorial edges via `mergeRelationships(semantic, authored.documentRelationships)`. Details: [docs/relationships.md](docs/relationships.md).

## Positional queries

Multi-token typed queries execute same-field positional clauses against runtime positional state for title, optional summary, and body. The serialized `search-v2-lexical-index` v1 artifact stores title/body positional postings only; optional summary positional state is hydrated from caller documents. Those clauses record field hits; they do not collapse the default public result list.

- **PhraseQuery** — exact contiguous typed (`originalSurface`) token sequence in one field.
- **PhrasePrefixQuery** — that sequence’s exact preceding tokens plus a trailing typed **proper prefix** of the next token in the same field.

These are runtime query clauses, not separately imported constructors. Optional `resultCollector: "complete-interpretation"` keeps documents that fully match an executed PhraseQuery or PhrasePrefixQuery, plus already-featured independent authored title evidence. It reads that already-executed query evidence; it is not a new ranking algorithm. Core omits the collector by default. The collector declines to restrict results for occupancy, configured-content identity, and version queries. Enablement is the caller’s, not Core policy.

```js
engine.search("rate lim", { resultCollector: "complete-interpretation" });
```

Details: [docs/schema.md](docs/schema.md), [docs/api.md](docs/api.md).

## Morphology

Lemmatization is corpus-specific. Core owns the morphology mechanism, not every catalog’s morphology policy. `morphology()` is the public factory; it is the current English implementation (suffix heuristics, a small built-in table, and optional `lemmas`). It does not run spaCy, WordNet, lemminflect, or a site lemma script.

```js
morphology({ lemmas: { intercepting: "interceptor", recursive: "recursion", foobars: "foobaz" } })
```

`intercepting` → `interceptor` and `recursive` → `recursion` are catalog-specific policy examples, not universal linguistic truth. Some of those mappings already live in Core's small default table. Site entries **augment** the defaults. Explicit built-in mappings win, so a generated table cannot replace stems the runtime already relies on (`computing` stays `compute`). Compile `compileLexicalIndex` / `compileLexicalFrequency` with the same `morphology({ lemmas }).lemma` used at search time, and pass that map to the Worker as `init({ englishOptions: { lemmas } })`.

Keep lemma generators, caches, and models in the site build. This package consumes a `Record<string, string>`, not the generator itself.

## TypeScript

Runtime implementation is authored in TypeScript and published as emitted ESM in `dist/`. Consumers execute that JavaScript, not `.ts` sources. Root and browser public types are generated from `src/index.ts` / `src/browser/index.ts` into `dist/*.d.ts`. Compiler subpaths still ship handwritten `.d.ts` under `tools/`. From a git checkout:

```bash
npm install
npm run build
npm run typecheck
npm run test:types
npm test
```

A repository checkout requires `npm run build` before executing the runtime, Jest tests, or `examples/catalog`. Python is outside `tsc`. Typecheck configs are not in the npm tarball; consumers use the shipped `dist` declarations for `.` and `./browser`.

`SearchEngine.create({ plugins })` accepts `SearchPlugin[]`. Custom `SearchPlugin` hooks are `lemma`, `canonicalLemma`, and `lexicon`. `compileAuthoredRelevance()` returns the ordered `SearchPlugin[]` needed for configured-concept recognition and authored relevance; do not hand-build compiled configured-concept internals. `morphology()` returns `EnglishPlugin`. Custom retrievers type as `ExperimentalRetriever`. Runtime still duck-types plugin objects and custom `retrieve` functions.

Authoring interfaces (`SearchPlugin`, `EnglishPlugin`, `LexiconPlugin`, `ExperimentalRetriever`) do not publish query-analysis or index internals. Custom retrievers remain experimental; `query` and `index` arguments are intentionally `unknown`. `morphology().lemma` typechecks. There is no public `english()` root export.

```ts
import { SearchEngine, type SearchPlugin, type ExperimentalRetriever } from "@software-land/search";

const plugin: SearchPlugin = {
  lemma(token) { return token; },
};

const retriever: ExperimentalRetriever = {
  retrieve() { return []; },
};

SearchEngine.create({ plugins: [plugin], retriever });
```

## API stability

v0. The runtime facade, result shape, artifact `format`+`version`, `relationshipStrategy` values, retriever names, and the optional search option `resultCollector: "complete-interpretation"` are intended to stabilize. Internal feature vectors, BM25 constants, and ranking modules are not public exports. PhraseQuery and PhrasePrefixQuery are runtime clauses, not root exports.

Supported imports: `@software-land/search`, `@software-land/search/browser`, `@software-land/search/corpus`, `@software-land/search/lexical`, `@software-land/search/relationships`, `@software-land/search/semantic`. The last four are build-time compilers/helpers. Root and `./browser` do not import them.

Root exports: `SearchEngine`, `morphology`, `compileAuthoredRelevance`, `migrateConfiguredEntry`, `mergeRelationships`, strategy/retriever constants, `parseRelationships`, abort helpers, public error classes, and types including `ConfiguredConcept`, `RelationshipMap`, `RelationshipArtifact`, `LexicalIndexArtifact`, `SearchPlugin`, `EnglishPlugin`, and `SearchOptions`. Equivalent recall is authored as directional `relationshipMap` `equivalent` edges. Configured-concept corpus artifacts (`ConfiguredConceptArtifact`, `parseConfiguredConcepts`) live on `@software-land/search/corpus`. `searchWorkerUrl()` is exported only from `./browser`.

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
| Scaling | [docs/scaling.md](docs/scaling.md) |
| Exact pruning | [docs/exact-pruning.md](docs/exact-pruning.md) |
| Compact lexical runtime | [docs/compact-runtime.md](docs/compact-runtime.md) |
| Lazy feature investigation (not shipped) | [docs/lazy-features.md](docs/lazy-features.md) |
| Known limitations | [docs/limitations.md](docs/limitations.md) |
| Security | [SECURITY.md](SECURITY.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Relevance evaluation (dev, GitHub tree; not in the npm tarball) | [benchmarks/relevance/README.md](https://github.com/Software-Land/search/blob/main/benchmarks/relevance/README.md) |
| Memory benchmarks (dev, GitHub tree; not in the npm tarball) | [benchmarks/memory/README.md](https://github.com/Software-Land/search/blob/main/benchmarks/memory/README.md) |
| Ranking envelope at fixed C (dev, GitHub tree; not in the npm tarball) | [benchmarks/ranking/README.md](https://github.com/Software-Land/search/blob/main/benchmarks/ranking/README.md) |

The checked-in toy fixture is evaluation machinery, not a ranking-quality claim.

## License

`@software-land/search` versions 0.5.0 and later are source-available under the Business Source License 1.1. Non-production use is free. Production use is also free for organizations with less than USD $10M in consolidated annual gross revenue. Organizations at or above that threshold require a commercial license from Software.Land.

See [LICENSE](LICENSE), [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

Versions through 0.4.0 remain Apache-2.0.
