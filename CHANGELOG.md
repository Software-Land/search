# Changelog

## 0.4.0 (unreleased)

### Breaking

- Public `english()` is removed. Canonical morphology is `morphology({ lemmas? }) => EnglishPlugin`. Plugin `name` remains `"english"`. Internal `createEnglishPlugin` / `english()` stay unpublished. Worker `init({ englishOptions })` is unchanged.
- `SearchEngine.create({ plugins })` is `SearchPlugin[]` rather than `unknown[]`. `dictionary()` returns `DictionaryPlugin`. Custom retrievers are `ExperimentalRetriever` rather than `{ retrieve: Function }`. Runtime still duck-types plugin objects and custom `retrieve` functions.
- Default `SearchEngine.create()` retrieval is `indexed` rather than `full-scan`. `indexed` now means exact compiled lexical retrieval: all legitimate matches are enumerated and exact representatives are selected by builtin constraint signature. `candidateLimit` remains accepted for compatibility but is not an exactness bound. Explicit `retriever: "full-scan" | "indexed" | "adaptive"` and custom `ExperimentalRetriever` objects remain available.

### Added

- Preferred public morphology factory `morphology({ lemmas })`, typed as `(options?: MorphologyOptions) => EnglishPlugin`. `MorphologyOptions` is `{ lemmas?: Record<string, string> }`, parallel to `dictionary({ entries })`. Plugin `name` stays `"english"`. Worker `init({ englishOptions })` is unchanged.
- Software.Land-derived real-corpus ranking coverage: 98 strict V2 contracts and 60 B-intent regressions (158 executable cases). Historical 215 scenarios remain provenance/audit data and are not Core contracts. Fixture provenance is frozen at corpus commit `dff24cf606967cb50b24d28d9142747c9203e053` and scenario commit `08e1b735ae01a3815964360ef3b9141466176dc4`.
- Candidate-stage survival checks on that fixture: expected contract/regression targets must appear in `meta.candidateTitles` before ranking, on both full-scan and indexed retrieval. Query `"2"` still keeps `200FPS` and `TLS 1.2 Vulnerability` in the candidate set.
- Identity-preserving sparse ranking for builtin constraint functions: candidates are grouped by constraint-relevant signatures, compared at the signature/bucket layer, and ordered with a heap over ready buckets. Same-class conflicts stay unordered. Incomparable buckets still interleave by score then `document.id`. Complete bipartite candidate edges are not materialized. Custom `ConstraintDef.fn` values still use the all-pairs path. Public ranking API is unchanged.
- Development-only ranking-envelope harness under `benchmarks/ranking/` (fixed C = 100, 200, 500, 1000; homogeneous / few-bucket / mixed workloads; frozen all-pairs oracle comparison). Not packed. Not a search-quality claim.
- Development-only feature-extraction harness under `benchmarks/features/` (fixed C; homogeneous / few-bucket / mixed / Software.Land queries; frozen extractor oracle comparison). Not packed. Not a search-quality claim.
- Development-only retrieval-mode harness under `benchmarks/retrieval/` (mixed synthetic N = 1k / 5k / 25k; full-scan / indexed / adaptive). Not packed. Not a search-quality claim. Not a CI latency gate.
- Fail-closed Software.Land retrieval-mode comparison: indexed and adaptive must match the frozen 215-row full-scan ordered results on that fixture.
- Deterministic `search-v2-lexical-index` v1 compilation under the existing `@software-land/search/lexical` entry point. Its unified positional streams hydrate exact lookup and compact query-time document views, with document/version metadata, compact surface→lemma ownership, corpus statistics, and compatibility/integrity fingerprints but no duplicated raw title/body or lexical-frequency maps.
- Narrow `SearchEngine.create({ lexicalIndex })` and Worker `init({ lexicalIndex })` inputs. Omission builds the equivalent exact structure once during `index()`; an invalid supplied artifact rejects instead of falling back.
- Exact compiled match enumeration and current-feature reconstruction with zero raw-document scans for supplied artifacts. Stage 1 deliberately has no WAND, MaxScore, block skipping, posting early termination, or approximate prefix truncation.
- Proven ordered top-R-per-builtin-signature selection for coherent query features, using the same rounded final score then `document.id` as the ranker and preserving first-seen signature order, same-class conflicts, and builtin SCCs. The complete featured map survives relationship target handling; channels derive a deeper prefix when required to preserve public absolute ranks and `constraintsVsNext`. Unknown custom constraints fail closed to all candidates.
- Deterministic pressure/differential coverage for the known `probezz`, `tiezz`, equal-tightness, high-DF `the`, `machine l`, and `machine le` candidate-budget failures, expanded Software.Land corpora, synthetic feature families, and packed Chromium Worker modes.
- Additive integrity-covered `exact-pruning-v1` document-ordinal boundaries under the existing lexical-index v1 extension namespace. Older v1 artifacts remain exact/exhaustive; malformed or unsupported claimed pruning metadata rejects.
- Exact Stage-2A document-feature block pruning for proven plain single-token body-only candidates. It preserves per-signature rounded-score/id prefixes, keeps an internal exhaustive compiled oracle, and exposes experimental visited/rejected/fallback counters. Posting enumeration remains exhaustive except for Stage-2B identical posting-array rewalks.
- Exact Stage-2B skip of posting arrays this query has already fully walked (duplicate token/concept/lemma/contextual lanes) when `retrievalScoreWeight` is `0`. Membership, provenance, and default ranking stay Stage-1 exact. Unread posting blocks, prefix expansions, and nonzero retrieval-score reconstruction stay exhaustive. No new lexical-index version or pruning extension.
- Compact compiled lexical runtime: interned term ids, packed token/offset views, and query-time document accessors instead of reconstructing per-document token/lemma arrays, Sets, and position Maps. `search-v2-lexical-index` v1 bytes and public search semantics are unchanged. Full-scan may keep fat objects. See `docs/compact-runtime.md`.
- Compact phrase adjacency, title-concept, and body-concept checks read packed token ids instead of `PackedTokenProxy` hot loops. Feature vectors and ranking are unchanged.
- `SECURITY.md` and `CONTRIBUTING.md`.

### Fixed

- Indexed retrieval was dropping ranking-critical `title-prefix` / short-literal winners (the query-`"2"` / `200FPS` class) when more than `candidateLimit` high-TF body matches existed. `title-prefix` is now a capped must-keep, same `prefixCap` bound as contextual title-prefix. Ranking features and constraint semantics are unchanged.
- Exact indexed retrieval no longer drops full-scan winners that occur below the old BM25-ish top-200 admission pool, including observed raw retrieval ranks around 5,006.

### Changed

- Builtin ranking no longer examines every candidate pair in the common case. Complexity is O(C log C + B²F + E_b) when the discrete signature count B is small, plus a localized pairwise fallback of size k when custom constraints are used (k = C). Worst case remains Θ(C²) when B = C or every constraint function is custom. This is not a claim of strict O(C log C) for every workload, of 5 ms search on all hardware, or of large-corpus full-scan scalability.
- Feature extraction caches query-local prep, bounds typo distance, and reuses in-memory independent-title and long-body token indexes. Ranking semantics, scores, constraints, explanations, candidates, and current query results are unchanged.
- Performance work was validated against all 215 production-derived Software.Land search scenarios, with the pre-optimization 0.4.0 engine used as an exact ordered-result oracle. The 98 strict contracts and 60 regression cases retain their existing stronger contract status; historical rows remain evaluation/provenance data.
- Indexed retrieval now compiles/loads exact positional statistics, enumerates all legitimate matches, reconstructs the unchanged features, keeps exact per-signature representatives, and invokes the existing sparse ranker. `candidateLimit` is not used to truncate the exact path. Stage 1 remains Θ(matches) in posting/feature work and does not claim a fixed hard C bound, strict subquadratic worst case, a universal 5 ms high-DF target, or final memory layout.
- Normal indexed/Worker result paths may omit full feature extraction for a block only when the exact reachable body-only signature, rounded score, and minimum-id tie bound prove that no member can enter the required representative stream. Multi-term/prefix/configured/version uncertainty, nonzero retrieval-score weight, full diagnostics, `all-strong`, active relationship expansion, custom/unknown ranking, and old artifacts fail closed to exhaustive Stage-1 evaluation. No WAND, MaxScore, posting-entry skipping, or approximate matching is introduced.
- Public `searchDetailed()` retains full candidate-title, cycle, conflict, related-count, global-rank, and explanation-successor semantics through an exact full diagnostic plan. Normal `search()`/`searchAsync()` and Worker results remain on the representative path.
- Site lemma generation is documented as build-time data. This package consumes a `Record<string, string>`. Software.Land's generator lives at https://github.com/Software-Land/search-lemma-tools as source/reference tooling for that blog corpus, not as a runtime or general-purpose dependency.

### Infrastructure

- GitHub Actions Playwright cache upgraded to `actions/cache@v6`.
- Investigation-only lazy-feature bound harness (`scripts/lazy-feature-profile.mjs`) and theorem tests. Not a production evaluator, not score-bound rejection, not a ranking change. Production still fully evaluates legitimate matches on the Stage-2C path. Not packed. Not a latency SLA.

## 0.3.1

### Added

- Opt-in public TypeScript authoring contracts: `SearchPlugin`, `EnglishPlugin`, `DictionaryPlugin`, `SynonymPlugin`, `LexiconPlugin`, `ExperimentalRetriever`, and `ExperimentalRetrieveOptions`. These are type-only. They do not narrow `SearchEngine.create({ plugins })` (`unknown[]`), `english()` / `dictionary()` (`unknown`), or the experimental `{ retrieve: Function }` retriever slot. Custom retrievers remain experimental; query/index payloads stay opaque and Search Core internals stay unpublished.
- Development-only exhaustive relevance-evaluation machinery under `benchmarks/relevance/` (schema, metrics, validator, toy fixture, runner). The toy fixture is not a search-quality benchmark and is not included in the npm tarball. Ranking is unchanged.
- Development-only memory benchmark under `benchmarks/memory/` (deterministic settings/article generators, RSS vs post-GC heapUsed). Not included in the npm tarball. Not a ranking-quality claim.

### Fixed

- High-document-frequency full-scan ranking no longer has the pathological graph-memory amplification. Unordered / no-decision pair reports are not retained; directed constraint edges are packed; SCC/order structures use compact CSR; cycle diagnosis reuses the SCC result. Ranking order, scores, explanations/meta, and public APIs are unchanged. Pairwise comparison remains Θ(C²).
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
