# @software-land/search

Deterministic, explainable document search with optional offline corpus and semantic compilation. Ranking uses named features and partial-order constraints. Relatedness is a **build-time artifact**, not a runtime embedding model.

Copyright 2026 Software.Land. 0.5.0+ is source-available under Business Source License 1.1.

Source: [github.com/Software-Land/search](https://github.com/Software-Land/search). This tree is **0.x**.

## What it is

A JavaScript **runtime** that indexes documents, searches them, explains hits, and can attach a related-document rail from a compiled graph. It does not download models, call an LLM, or depend on a CMS.

Pairwise ranking used to be Θ(C²) in the candidate set C. Builtin ranking now groups constraint-equivalent candidates and compares signatures (B of them) instead of every pair; worst case remains Θ(C²) when B = C or constraints are custom. Default **indexed** retrieval enumerates every legitimate match, then retains exact per-signature representatives for ranking; pass `retriever: "full-scan"` only as an explicit reference mode. A narrow exact Stage-2A path can reject full feature work for proven single-token body-only blocks, but posting/membership work remains Θ(matches).

**Zero production npm dependencies.** Node 18+.

Optional **offline compilers** (not required to search; not imported by the runtime):

- `search-corpus` — configured concepts and equivalent `relationshipMap` edges from a portable `{id,title,body}` corpus
- `search-lexical` — lexical-frequency n-gram counts and the exact positional lexical index
- `search-relationships` — editorial / semantic relationship graphs
- Python `tools/search-semantic` — optional relatedness builder, shipped in the npm package and launched via `@software-land/search/semantic`

Generated compiler candidates are review material. Only trusted compiled artifacts enter the runtime.

## Install

```bash
npm install @software-land/search
```

```js
import { SearchEngine, morphology, compileAuthoredRelevance } from "@software-land/search";

const authored = compileAuthoredRelevance({
  configuredConcepts: [{ key: "wifi", aliases: [["wi", "fi"]] }],
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
});

await engine.index([
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
]);

engine.search("wireless");
```

`wifi` as a single token does not match the title `Wi-Fi` unless you configure an alias. That is corpus configuration, not a Core heuristic.

## Morphology

Lemmatization is corpus-specific. Core owns the morphology mechanism, not every catalog's morphology policy. `morphology()` is the public factory; it is the current English implementation (suffix heuristics, a small built-in table, and optional `lemmas`). It does not run spaCy, WordNet, lemminflect, or a site lemma script.

Pass generated or editorial maps as data:

```js
morphology({ lemmas: { intercepting: "interceptor", recursive: "recursion", foobars: "foobaz" } })
```

`intercepting` → `interceptor` and `recursive` → `recursion` are catalog-specific policy examples, not universal linguistic truth. Some of those mappings already live in Core's small default table. Site entries **augment** the defaults. Explicit built-in mappings win, so a generated table cannot replace stems the runtime already relies on (`computing` stays `compute`). The Worker takes the same map as `init({ englishOptions: { lemmas } })`. Compile lexical-frequency n-grams with the same `morphology({ lemmas }).lemma` used at search time.

Keep lemma generators, caches, and models in the site build. This package consumes a `Record<string, string>`, not the generator itself. Those Python/model dependencies do not enter Search Core or the browser/runtime package dependency graph.

## Authored relevance

Applications author configured concepts and a directional `relationshipMap`, then compile them once:

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

Search data is four distinct layers:

| Name | Meaning |
| --- | --- |
| `configuredConcepts` | authored identities `{ key, aliases }` |
| `lexicalIndex` | corpus lexical term/posting index |
| `relationshipMap` | authored form/concept/document relevance |
| `documentRelationships` | compiled document-to-document graph |

`configuredConcepts` is the authored identity list `{ key, aliases }`. It is not the corpus lexicon; term postings live in `lexicalIndex`.

`authored.plugins` is the compiler-owned plugin list: configured identity (including related standalone/topical recall) followed by compiled equivalent one-hop recall. Ordinary applications do not assemble those pieces by name. `equivalent` edges are directional and do not auto-reverse. `qa → testing` does not imply `testing → qa`. When equivalence is symmetric, author both directions. Trusted corpus-mined accepted groups do this automatically by compiling each group into a bidirectional equivalent clique. Phrase sources match as exact contiguous normalized phrases.

`authored.documentRelationships` is the editorial document→document artifact, or `null` when none were authored. Combine it with a generated semantic artifact using `mergeRelationships(semantic, authored.documentRelationships)`.

Complete authored relevance — equivalent recall, related standalone/topical forms, and editorial document edges — uses `compileAuthoredRelevance()`.

## Browser Worker

Optional. Core does not import `Worker` or `window`.

```js
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const client = createSearchClient({
  workerUrl: searchWorkerUrl(),
  onResult({ query, result }) { /* render */ },
});

await client.init({
  documents,
  schema,
  configuredConcepts,
  relationshipMap,
  documentRelationships,
  lexicalIndex,
  retriever: "indexed",
});
client.setQuery("bluetooth");
client.dispose();
```

`searchWorkerUrl()` resolves the bundled Worker **from this package** (`import.meta.url` of the browser entry). Consumers should not build a Worker URL against their own module; that would miss `searchWorker.js`. Omitting `workerUrl` uses the same default.

Protocol is plain `postMessage`. Latest-wins: a new query replaces pending work and cancels stale running searches.
Omit `lexicalIndex` to construct the exact fallback index once inside the Worker; a supplied invalid artifact rejects initialization. `relationshipMap` has the same authored meaning as in-process `compileAuthoredRelevance()`.

## Corpus compiler

Node CLI. Search Core never imports this tool.

```bash
node tools/search-corpus/build.mjs analyze --input corpus.json --output dir
node tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions decisions.json
```

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

## Lexical compilers

`@software-land/search/lexical` owns both optional build-time artifacts.

Lexical-frequency n-gram counts:

```js
import { compileLexicalFrequency, attachLexicalFrequency } from "@software-land/search/lexical";

const artifact = compileLexicalFrequency(documents, { lemma: morphology().lemma });
await engine.index(attachLexicalFrequency(documents, artifact));
```

Default policy: unigrams plus bigrams (n=1–2), keep keys whose collection occurrence count is at least 2. Phrase keys are built in the shared tokenize → lemma → stop-word removal space used by runtime query lookup (`machine learning` → `machine learn`, `foo the bar` → `foo bar`). n=2 is the smallest default that keeps adjacent-term phrase evidence without materializing every longer substring.

The exact positional retrieval index:

```js
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

The artifact format is `search-v2-lexical-index` version 1. It is a unified analyzed-index representation: stable document metadata, a sorted surface dictionary, positional title/body streams, compact surface→lemma ownership, version/dotted-span metadata, and corpus statistics hydrate both exact lookup and compact query-time document views. Raw title/body text and per-document lexical-frequency maps are not duplicated; supplied documents remain fingerprint-validated owners of display titles and attached `lexicalFrequency` data, typically produced from the separate build artifact with `attachLexicalFrequency()`.

The default exact indexed path enumerates legitimate matches, reconstructs the same current features, and keeps mathematically sufficient representatives per builtin constraint signature before sparse ranking. Its additive v1 pruning extension can skip full feature evaluation for blocks whose reachable signature and rounded score are proved exactly. Stage 3A may skip unread noncompetitive 1-of-k body postings on ordinary exact multi-token compiled `search()` using additive `exact-pruning-v2` presence masks; results stay identical to exhaustive compiled search. Uncertain, prefix, diagnostic, custom, and active-relationship cases fail closed to exhaustive retrieval. This is not WAND/MaxScore/early termination. A supplied incompatible or corrupt artifact throws. If the artifact is omitted, each `index()` call compiles equivalent state from `documents`; this performs raw lexical analysis during initialization but still performs zero query-time raw-document scans. `retriever: "full-scan"` remains the reference mode.

After successful initialization from a supplied artifact, the engine releases its reference to the artifact envelope and parsed document tuples. Callers still own their original artifact reference and can release it after `index()` resolves or a Worker reports `ready`. A subsequent identical `index()` reuses that hydrated artifact state; incompatible replacement documents reject.

## Relationship compiler

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json --domain domain.json \
  --semantic relationships-from-builder.json --output dir
```

```js
import { compileRelationships } from "@software-land/search/relationships";
```

## Optional semantic compiler (Python)

Shipped in the npm package. Search Core never imports it. Lexical relatedness uses the Python standard library. Embedding extras are installed into an isolated venv on first `combined` / `embedding` compile:

```js
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

```bash
node tools/search-semantic/build.mjs --input corpus.json --output graph.json --method embedding --precision-gate --mutual
python3 tools/search-semantic/build.py --input corpus.json --method lexical --output graph.json
```

Default embedding model (when requested): `sentence-transformers/all-MiniLM-L6-v2`. Weights are downloaded into a builder cache and are not redistributed. See `tools/search-semantic/LICENSES.md`.

## Artifact flow

```text
corpus JSON
  → search-corpus          → configured-concepts.json + relationship-map.json
  → search-lexical         → search-v2-lexical-frequency v1
                           → search-v2-lexical-index v1
  → search-semantic (opt.) → relationships (semantic)
  → search-relationships   → search-v2-relationships v1
  → SearchEngine.create({ lexicalIndex, documentRelationships, plugins from configuredConcepts })
```

Runtime parsers validate each artifact's `format` + `version`; lexical indexes additionally fail closed on integrity, analyzer, schema, or corpus mismatch.

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

`SearchEngine.create({ plugins })` accepts `SearchPlugin[]`. Custom `SearchPlugin` hooks are `lemma`, `canonicalLemma`, and `lexicon`. `compileAuthoredRelevance()` returns the ordered `SearchPlugin[]` needed for configured identity and authored relevance; do not hand-build compiled identity internals. `morphology()` returns `EnglishPlugin`. Custom retrievers type as `ExperimentalRetriever`. Runtime still duck-types plugin objects and custom `retrieve` functions.

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

v0. The runtime facade, result shape, artifact `format`+`version`, `relationshipStrategy` values, and retriever names are intended to stabilize. Internal feature vectors, BM25 constants, and ranking modules are not public exports.

Supported imports: `@software-land/search`, `@software-land/search/browser`, `@software-land/search/corpus`, `@software-land/search/lexical`, `@software-land/search/relationships`, `@software-land/search/semantic`. The last four are build-time compilers/helpers. Root and `./browser` do not import them.

Root exports: `SearchEngine`, `morphology`, `compileAuthoredRelevance`, `migrateConfiguredEntry`, `mergeRelationships`, strategy/retriever constants, `parseRelationships`, abort helpers, public error classes, and types including `ConfiguredConcept`, `RelationshipMap`, `RelationshipArtifact`, `LexicalIndexArtifact`, `SearchPlugin`, and `EnglishPlugin`. Equivalent recall is authored as directional `relationshipMap` `equivalent` edges. Configured-concept corpus artifacts (`ConfiguredConceptArtifact`, `parseConfiguredConcepts`) live on `@software-land/search/corpus`. `searchWorkerUrl()` is exported only from `./browser`.

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

`@software-land/search` 0.5.0+ is source-available under the Business Source License 1.1. Non-production use is free. Production use is also free for organizations with less than USD $10M in consolidated annual gross revenue. Organizations at or above that threshold require a commercial license from Software.Land.

See [LICENSE](LICENSE) and [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md).

Versions through 0.4.0 remain Apache-2.0.
