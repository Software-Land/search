# Build-time tools

Search Core never imports these. Runtime users should not pay for them.

`npm run typecheck` typechecks Core, the browser Worker/client, and TypeScript-migrated tools (`tools/search-lexical`, `tools/search-relationships`, `tools/search-corpus`, `tools/search-semantic` Node) after `npm run build` (runtime JS is emitted to `dist/`; root and browser public declarations are generated into `dist/*.d.ts`; lexical JS/DTS are emitted beside `tools/search-lexical` source; relationships, corpus, and semantic Node JS are emitted beside their TypeScript source while their public `.d.ts` files remain the handwritten v0.2.2 contract). The Python sources under `tools/search-semantic/lib` stay outside `tsc`. `npm run test:types` compiles consumer fixtures in `test/types/` against the public `package.json` `exports.types` surface after the same build.

## search-corpus (`tools/search-corpus`)

Lexical / domain compiler + durable review workflow.

```text
corpus JSON → analyze → inspection + pending queue
                         durable decisions.json  (source-controlled)
                         compile → configured-concepts.json + relationship-map.json
```

Generated candidates are **not** runtime truth. Only trusted decisions (`AUTO_ACCEPTED` / human accept / explicit manual) enter artifacts, per current compiler semantics. Directional one-hop recall is authored as `equivalent` edges on `relationshipMap` and compiled with `compileAuthoredRelevance()`.

```bash
# Git checkout:
node tools/search-corpus/build.mjs analyze --input corpus.json --output dir
node tools/search-corpus/build.mjs compile --input corpus.json --output dir --decisions decisions.json
node tools/search-corpus/build.mjs review --pending --output dir

# npm install: node_modules/@software-land/search/tools/search-corpus/build.mjs
```

Public entry: `compileCorpus` / `analyzeCorpus` / `reconcileExternalConfiguredConcepts` from `@software-land/search/corpus`. Internal miners are not a supported app API. Applications may generate untrusted configured-concept **candidate** rows outside the package (`key` plus candidate `expansion` and/or `aliases`, plus optional review fields such as `evidenceDocumentIds`). `reconcileExternalConfiguredConcepts` canonicalizes keys/forms, clusters compatible duplicates (including British/American suffix spelling and conservative short-form abbreviations such as tech/technical), rejects malformed rows, and records material same-key ambiguity or genuine conflict as unresolved inspection evidence instead of deleting the key. Successful identities project to `configuredConcepts` (`ConfiguredConcept[]`, aliases as unordered peers; any serialization sort is not a ranking signal) for `compileAuthoredRelevance()`. Candidate `expansion` is miner/review provenance and is not a privileged `ConfiguredConcept` field. Compact keys fold separator punctuation between alphanumeric groups (`CI/CD` → `cicd`, `TCP/IP` → `tcpip`) and refuse silent collapse of significant symbols (`A*`, `C++`, `C#`, `O(1)`). The package does not select, download, or run a model.

## search-lexical (`tools/search-lexical`)

`compileLexicalFrequency` builds integer n-gram counts (unigrams and short phrases) from the **body field only**, in the same tokenize → lemma → stop-strip → contiguous 1–2 gram space as Search Core phrase lookup. Title and body are never concatenated, so n-grams cannot span the title/body boundary. Duplicate document ids follow SearchEngine.index (last document wins) **before** collection counts. Policy `minN`, `maxN`, and `minCollectionCount` must be finite positive integers with `maxN >= minN`. Runtime consumes the resulting data through `document.lexicalFrequency` maps produced by `attachLexicalFrequency`; it does not accept that artifact as a separate engine option.

`compileLexicalIndex` builds a `search-lexical-index` artifact with schema version 1, the positional/analyzed artifact used by exact indexed retrieval. Pass the same schema and document lemma function used by the runtime; supplying `lemma` also requires its deterministic `analyzerId` (`morphology().indexIdentity` for the builtin plugin). Supplied documents remain required for corpus-fingerprint validation and attached lexical-frequency ownership. Both compilers are public from `@software-land/search/lexical`; Search Core never imports the build tool.

## search-semantic (`tools/search-semantic`)

Optional Python builder, shipped in the npm package: documents → offline embeddings or lexical neighbors → optional precision gate and mutual-neighbor filter → a `search-relationships` artifact with schema version 1. Public Node entry: `compileSemantic` from `@software-land/search/semantic` (`precisionGate`, `mutual`, `embeddingProvider`). When `outputPath` is omitted, the launcher creates a unique temp-location output file that survives the call; the caller owns that returned file. Search Core never imports this.

The default provider is FastEmbed. Omitting `embeddingProvider` or `--embedding-provider` keeps that default. The only accepted explicit values are `fastembed` and `openai`; any other value is rejected before Python discovery or virtualenv setup. A present CLI flag with no value does not fall back to the default. The FastEmbed model (`all-MiniLM-L6-v2` unless `model` is set) is tooling configuration, not a Core API. See `tools/search-semantic/LICENSES.md`. FastEmbed weights are downloaded separately into a builder cache.

`embeddingProvider: "openai"` is opt-in offline generation. The documented initial model is `text-embedding-3-large` at 3072 dimensions. Credentials are `OPENAI_API_KEY` or `apiKey`, and are not stored in the artifact. The OpenAI environment installs NumPy and tiktoken (`requirements-openai.txt`); it does not install FastEmbed. FastEmbed also uses NumPy, from `requirements-embed.txt`. tiktoken is only installed for the OpenAI path. `text-embedding-3-large`, `text-embedding-3-small`, and `text-embedding-ada-002` are counted with `cl100k_base`. The Node wrapper and the Python CLI use the same Python loader. The ranks are not bundled. The first count of uncached OpenAI inputs downloads the public asset `https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken` with a 60-second timeout, without `OPENAI_API_KEY` and without using `OPENAI_API_BASE`. The download is kept only when its SHA-256 is `223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7`. The default cache directory is `build/search-semantic/tokenizers/` in the caller’s working directory. Direct Python builds and `prepare_tokenizer.py` resolve it from the process working directory when they start. The Node wrapper records that directory before asynchronous setup and passes an absolute path, because it starts Python inside the installed package. A nonempty relative `TIKTOKEN_CACHE_DIR` or `DATA_GYM_CACHE_DIR` is resolved against the same directory; an absolute override stays absolute. The cache is separate from the installed package and from temporary compilation output. Deleting the project’s `build` directory deletes the ranks; the next OpenAI count that needs them downloads the file again. `TIKTOKEN_CACHE_DIR` overrides the default. An empty value skips persistence and still checks the checksum. If `TIKTOKEN_CACHE_DIR` is unset, `DATA_GYM_CACHE_DIR` is the older tiktoken name for the same directory. An empty `DATA_GYM_CACHE_DIR` does not fall through to the project directory. The file name is the SHA-1 of the asset URL (`9b5ad71b2ce5302211f9c61530b329a4922fc6a4`). Copy a verified file there to prewarm a build machine that cannot reach the public URL, or run `python3 tools/search-semantic/prepare_tokenizer.py` where the network is available. That command uses the same loader, needs no API key, and does not download when the cached bytes already match. Python tests expect this preparation and do not download the ranks themselves. A verified cache hit does not download. Importing the builder, lexical builds, FastEmbed builds, browser search, and an OpenAI build satisfied entirely by cached embedding vectors do not fetch it. Any other model fails before a request, because this builder does not estimate token length. Requests stay within 8,192 tokens per input and 250,000 counted tokens per request (the API request limit is 300,000). `text-embedding-3-large` sends its dimension. `text-embedding-3-small` requires `--dimensions`. `text-embedding-ada-002` is fixed at 1536: omit the dimension or pass 1536, and the request leaves `dimensions` out. Embedding-vector cache hits skip the API. Re-evaluate `minScore` when changing models, because a floor chosen for one embedding space does not transfer. Runtime search still has no model dependency.

## search-relationships (`tools/search-relationships`)

Merges semantic graph + explicit domain relationships. Stable relationship identity, direction, and provenance.

```bash
# Git checkout:
node tools/search-relationships/build.mjs compile \
  --input corpus.json --domain domain.json \
  --semantic relationships-from-builder.json --output dir

# npm install: node_modules/@software-land/search/tools/search-relationships/build.mjs
```
