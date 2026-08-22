# Changelog

## 0.3.1 — Unreleased

### Added

- Opt-in public TypeScript authoring contracts: `SearchPlugin`, `EnglishPlugin`, `DictionaryPlugin`, `SynonymPlugin`, `LexiconPlugin`, `ExperimentalRetriever`, and `ExperimentalRetrieveOptions`. These are type-only. They do not narrow `SearchEngine.create({ plugins })` (`unknown[]`), `english()` / `dictionary()` (`unknown`), or the experimental `{ retrieve: Function }` retriever slot. Custom retrievers remain experimental; query/index payloads stay opaque and Search Core internals stay unpublished.

### Changed

- Ranking constructs the pairwise constraint graph once per `rankCandidates` / `rankCandidatesAsync` call and reuses it for cycle diagnosis. Pairwise evaluation remains Θ(C²). Search result order, scores, constraints, and explanation/meta shapes are unchanged.

### Fixed

- Default `compileSemantic()` no longer returns `outputPath` inside the internal work directory that `finally` deletes. When `outputPath` is omitted, the launcher writes a unique `search-semantic-output-*.json` file under the system temp directory that survives the call. The caller owns that file. Explicit `outputPath` is unchanged. Artifact bytes and schema are unchanged.

## 0.3.0

### Breaking

- `@software-land/search/relationships` no longer mines relationship candidates or runs a human-review workflow. Removed `analyzeRelationships`, relationship `LIFECYCLE`, `mine` / `--no-mine`, and the `analyze` / `review` CLI commands.
- Explicit domain relationships replace relationship decisions. `CompileRelOptions.domain` is the compile input (`compileRelationships(documents, { semantic, domain, runtimeTypes })`). Format is `search-relationships-domain`. Each record is `{ source, target, type, directional?, priority?, provenance?, note? }` with required `type`.
- Unresolved domain endpoints and missing or unknown `type` fail compile with `RelationshipError`.
- Removed from `/relationships`: `loadDecisions`, `validateDecisions`, and `DecisionError`. Corpus `DecisionError` is unchanged.
- Relationship `COMPILER_VERSION` is `2`. The runtime artifact remains `search-v2-relationships` version `1`.

### Fixed

- Standalone query `"2"` no longer treats the dotted-span title component in `TLS 1.2` as independent exact-title evidence. Lead short-literal titles such as `200FPS` rank above that weak dotted-span match.
- Public `filterRelationships(artifact, types?: readonly string[])` honors a caller-supplied type array. `null` / `undefined` and other invalid runtime values use the default search-eligible types instead of throwing.

### Changed

- Explicit domain edges still default provenance to `"manual"` when omitted. Semantic edges keep builder scores and provenance.

This release does not change the runtime relationship artifact schema.

## 0.2.3

### Changed

- Node build-tool implementation source migrated from JavaScript to TypeScript: `@software-land/search/lexical`, `@software-land/search/relationships`, `@software-land/search/corpus`, and the Node wrapper/CLI for `@software-land/search/semantic`. Emitted JavaScript remains what npm consumers execute. Documented `build.mjs` CLI paths remain compatible.
- All production Node runtime and Node build-tool implementation source is now TypeScript, while the semantic compiler remains Python and small compatibility launchers/tests/scripts remain in their appropriate languages. Semantic Python remains build-time only.
- Handwritten public declarations remain frozen where generated declarations would alter the v0.2.2 contract. Lexical declaration output remains contract-equivalent.
- Documented the existing morphology ownership contract: Core owns the `english()` mechanism (suffix heuristics, small built-in table, merge/precedence). A site/catalog may supply corpus-specific lemma data through `english({ lemmas })` and Worker `englishOptions`. Site-specific spaCy / lemminflect / model generation remains outside Core and the browser/runtime dependency graph.
- Public/runtime/search behavior remains compatible with v0.2.2. The existing six supported public package specifiers remain unchanged. Zero production dependencies. Node >=18 remains supported.

### Infrastructure

- GitHub Actions `actions/checkout` and `actions/setup-node` updated to v5.

This patch does not retune ranking, change artifact format versions, add a query-time model/vector/LLM dependency, change the Worker protocol, or break the public API.

## 0.2.2

### Fixed

- Compact version companions now use the repaired typed token for typed-completeness evidence, so inferred unique-prefix completion cannot satisfy short companion queries such as `12 vuln`.

### Changed

- Clarified the query-token provenance contract: typed/repaired forms are distinct from canonical retrieval identity and inferred completion.
- Documented the extension seam for future semantic retrievers: semantic query input should come from the raw or repaired typed query, not from projected lexical tokens.

This patch does not change public package exports, artifact formats, Worker behavior, or the model-free runtime architecture.

## 0.2.1

### Changed

- Runtime source implementation migrated from JavaScript to TypeScript. npm runtime output is now emitted under `dist/`.
- The existing six supported public package specifiers remain unchanged. Public/runtime/search behavior remains compatible with 0.2.0.
- Browser Worker packaging now emits `dist/browser/searchWorker.js`. Consumers continue to use `searchWorkerUrl()`.
- Build-time corpus, relationship, lexical, and semantic tooling remains under `tools/`. Semantic Python remains build-time only.
- Zero production dependencies. Node >=18 remains supported.

This patch does not retune ranking, change artifact format versions, or break the public API.

## 0.2.0

### Added

- `@software-land/search/lexical` compiles integer term/phrase n-gram counts at build time (default: unigrams + bigrams, collection count ≥ 2). Search Core looks up `bodyPhraseCount` / `bodyPhraseFrequency` from that artifact and does not rescan the corpus at query time.
- Worker `InitPayload.englishOptions` forwards lemma maps into `english()`. Site lemmas augment built-in defaults; explicit `DEFAULT_LEMMAS` win.

### Fixed

- An exact configured acronym/key and its unique full expansion identify the same concept. Retrieval and ranking use the lemmatized expansion as canonical lexical intent (the same terms a unique partial expansion already used), so `ml`, `machine learning`, and `machine learn` share ordered results. Provenance stays distinct (`key` / `expansion` / `partial-expansion`). Shared expansions still do not collapse to an arbitrary key. Extra expansion-word term concepts are not emitted. A single expansion token is not full equivalence evidence for a multi-token key.
- Multi-token queries: repeated compiled full-phrase body evidence outranks weak/incidental direct evidence (incidental title-token overlap and weak body-only hits). It does not outrank strong or moderate title evidence, exact title, configured key-in-title, canonical key title, full query/title coverage, or contextual aligned prefix, and it is not a universal `bodyPhraseCount` comparison.
- Unique prefix completion and explicit lemma-table morphology rewrite the retrieval token to the canonical lemma. Typed surface stays in `surface` / `completedToken` / `prefixCompletion`. Suffix-heuristic stems do not rewrite retrieval tokens. Ambiguous prefixes are not rewritten.
- A unique left-prefix of a longer configured expansion (≥2 aligned tokens, coverage ≥ 2/3) is partial-expansion evidence. It does not collapse to the key. Ambiguous shared prefixes and single-token expansion words do not qualify. Incomplete configured-key prefixes match only the unused final active query token, and only when the matching key is unique.
- Typed/repaired surface stays observable as `surfaceNormalized` and `typedSurfaceTitleMatch` after canonical retrieval rewrite. For single-token queries, exact typed surface-title agreement outranks lemma-only title matches (H3). Multi-token phrase identity is unchanged.
- Contextual title-sequence prefix: when preceding query tokens align with the title start, the final token may be a short proper prefix of the aligned title token. Standalone stubs (`ap`, `c`, `co`) stay strict. Aligned title-sequence evidence outranks weak/incidental competitors, not every non-contextual candidate. Among contextual hits, tighter completions rank first.
- Lexical-frequency compilation uses the same `DEFAULT_STOP` set as runtime phrase lookup. Custom compiler `stopWords` is not a 0.2.0 option.
- Compiled phrase lookup and phrase-evidence token count use the canonical lexical intent (`lexicalTokens` / `lexicalPhraseKey`), so unique key and exact-expansion forms match compiled n-grams such as `machine learn`.

## 0.1.2

### Added

- The npm tarball now includes the optional Python semantic compiler (`tools/search-semantic`) and a Node launcher at `@software-land/search/semantic`. Search Core and `@software-land/search/browser` still do not import it. Model weights remain downloaded into a builder cache and are not written into runtime JSON.
- `compileSemantic` / `build.py` accept `precisionGate` and `mutual` to drop prefix false-friends, drop contrastive `vs` pairs with no shared content token of length ≥ 4, then keep A→B only when B also retains A. Default remains off.

## 0.1.1

### Fixed

- Relationship expansion primary selection now follows Search Core ranking, so `top1-strong` no longer falls back to lexicographic document ids when scores are unset.
- Equal-distance typo corrections use a stable lexical tie-break, independent of corpus insertion order.
- Duplicate-id indexes build typo vocabulary from the last-document-wins collection only.
- `searchAsync()` uses `retrieve()` when a custom retriever omits optional `retrieveAsync`.
- `meta.relationshipMs` now measures relationship expansion instead of always reporting `0`.

### Infrastructure

- GitHub Actions CI on `push` and `pull_request` to `main`.
- Public tests and docs no longer use internal development chronology.

This patch does not retune ranking, change artifact format versions, or break the public API. Existing `search-v2-*` serialized artifact identifiers remain supported.

## 0.1.0

Initial public release.
