# Changelog

## 0.5.0

### Breaking

- License: 0.5.0 changes the license from Apache-2.0 to Business Source License 1.1 (SPDX: `BUSL-1.1`). Non-production use remains free. Production use is free under the Additional Use Grant when the consolidated annual gross revenue of you and your Affiliates is less than USD $10,000,000. Organizations at or above that threshold require a commercial license from Software.Land. The Change License is Apache License, Version 2.0. Versions through 0.4.0 remain Apache-2.0; this release does not revoke or replace those grants. See `LICENSE` and `COMMERCIAL-LICENSING.md`.
- Configured concepts are authored as `{ key, aliases }` plus optional identity metadata (`type`, `provenance`, `confidence`). Aliases are unordered semantic peers: alias array order has no search semantic effect. `key` remains stable concept identity and the lexical key form. Every alias compiles as an equal non-key sequence kind `form`. The public authoring schema no longer has `exp` / `expansion` or `primary`. Standalone and topical recall are not ConfiguredConcept fields. `migrateConfiguredEntry()` emits a `ConfiguredConcept` (`{ key, aliases, type?, provenance?, confidence? }`); former `exp` / `expansion` becomes one peer alias; `primary` is discarded and standalone/topical recall are extracted into relationship descriptors.
- Explicit application-owned relevance is authored in directional `relationshipMap` with kinds `equivalent` and `related`, and typed endpoints `{ form } | { concept } | { document }`. Edges do not auto-reverse and must not carry numeric weights. `equivalent` compiles onto the package's existing one-hop recall machinery. `related` token→concept compiles onto existing standalone-recall semantics. `related` concept→form compiles onto existing topical-recall semantics. `related` document→document compiles onto existing editorial relationship artifact semantics (`type: editorial`, provenance `manual`, strength 1).
- Generated semantic / MiniLM document relationships remain a separate generated pipeline. They are not authored in `relationshipMap`.
- One-shot `migrateConfiguredEntry(old)` converts `{ key, exp|expansion, aliases, primary, type, provenance, confidence, standaloneRecall, topicalRecall }` into a `ConfiguredConcept` (`{ key, aliases, type?, provenance?, confidence? }`) plus extracted standalone/topical relationship descriptors. Identity metadata `type` / `provenance` / `confidence` is preserved when supplied. `primary` is discarded and is not mapped to any relationship. Runtime `compileAuthoredRelevance()` / `SearchEngine` do not call the helper.
- Public initialization terminology now distinguishes configured concept definitions from the corpus lexicon and compiled document graph: `dictionaryEntries` is now `configuredConcepts`, and document relationship inputs use `documentRelationships` instead of `relationships`. This applies to `SearchEngine.create`, Worker `SearchClient.init`, and `compileCorpus()` results. The versioned `search-v2-relationships` artifact still stores its graph under the inner `relationships` map.
- The public configured-concept type is `ConfiguredConcept` (`{ key, aliases?, type?, provenance?, confidence? }`). `EquivalenceEntry` is removed. There is no compatibility alias.
- The versioned configured-concept artifact is `search-v2-configured-concepts` (`ConfiguredConceptArtifact`, `parseConfiguredConcepts`) on `@software-land/search/corpus`. Root no longer exports `EquivalenceArtifact` or `parseEquivalences`. `search-v2-equivalences` is not accepted. 0.4 `search-v2-equivalences` artifacts must be regenerated/migrated for 0.5. The compiler writes `configured-concepts.json`.
- Public TypeScript plugin types `DictionaryPlugin` and `SynonymPlugin` are removed. `SearchPlugin` is the public plugin contract. `compileAuthoredRelevance()` returns ordered `SearchPlugin[]` for configured-concept recognition and authored relevance. Public `SearchPlugin` no longer exposes published 0.4 fields `expand`, `sequences`, or `byKey`. `sequences` and `byKey` are compiled configured-concept internals. Author configured concepts through `configuredConcepts` and `compileAuthoredRelevance()`. Runtime compiler plugins may still carry those fields internally; JavaScript duck typing of those compiler products is not the public authoring contract. Compiled related-recall maps (`standaloneRecallByToken`, `topicalRecallByKey`) are not public `SearchPlugin` fields and were never published on 0.4 `SearchPlugin`. Equivalent recall is authored as `relationshipMap` `kind: "equivalent"` and compiled with `compileAuthoredRelevance()`. Related recall is authored as `relationshipMap` `kind: "related"`.
- Public explain/retrieval provenance `configured-equivalence` is now `configured-concept`. It names configured-concept identity evidence. `relationshipMap` `kind: "equivalent"` recall is `equivalent-recall`.
- Occupied configured concepts in explain output now use `query.concepts[].kind: "configured-concept"` instead of `"acronym"`. The old value was the historical tag for configured concepts and did not imply that the configured concept was literally an acronym. Experimental `meta.stage3AFallbackReason` also uses `"configured-concept"` instead of `"acronym"` when configured occupancy is the failing Stage 3A check. There is no compatibility alias.
- Explain ranking feature `configuredEquivalenceMatch` is now `configuredConceptMatch`. Values are `false`, `"key-in-title"`, or `"form"` (`"form"` means a peer form is in the title, not a privileged expansion / `aliases[0]`). The field is configured-concept title identity, not `relationshipMap` `kind: "equivalent"`. There is no compatibility alias.
- Occupied configured-concept explain/runtime names that previously said `expansion` for a peer form now say `form`: `configuredSequenceIntent.matchedForm`, `QueryConcept.matchedForm` / `matchedFormTokens` / `formTokenCount` / `formCoverage`, `configuredFormEvidence`, `configuredFormCoverage`, `configuredFormBodyMatch`, `contextualCompletion.source: "configured-form-prefix"`, and provenance `partial-form`. 0.4 `exp` / `expansion` authoring and miner/review candidate `expansion` are unchanged. There are no compatibility aliases for the unpublished 0.5 expansion names.
- `compileAuthoredRelevance({ configuredConcepts, relationshipMap, documents })` is the public application compiler. It returns `{ plugins, documentRelationships }` for direct SearchEngine initialization: `plugins` is the ordered authored relevance plugin collection, and `documentRelationships` is the editorial document→document artifact or `null`. Explain provenance may still say `standaloneRecall` / `topicalRecall` because those remain compiled runtime/explain names, not authoring fields. Equivalent recall explain names are `equivalent-recall` / `equivalentRecall`.
- The low-level `dictionary()` root factory has been removed from the public API. Configured concept authoring uses `compileAuthoredRelevance({ configuredConcepts, ... })`. 0.4 identity-only `SearchEngine.create({ plugins: [morphology(), dictionary({ entries })] })` or a custom `SearchPlugin` typed with `sequences` / `byKey` becomes `plugins: [morphology(), ...compileAuthoredRelevance({ configuredConcepts: entries }).plugins]`.
- Custom Worker hosts: 0.4 `createWorkerRuntime({ dictionary })` with `dictionary({ entries })` is now `createWorkerRuntime({ compileConfiguredConceptPlugin })` with `compileConfiguredConceptPlugin({ configuredConcepts })`. There is no compatibility alias. `relationshipMap` still requires `compileAuthoredRelevance` (or the packaged Worker compiler).
- The `search-v2-synonyms` artifact and `parseSynonyms()` compatibility API have been removed. Equivalent relevance is represented through directional `relationshipMap` `equivalent` edges. Corpus-generated synonym/equivalence output now uses the same relationship model; 0.4 synonym artifacts must be regenerated/migrated when upgrading.
- `@software-land/search/corpus` compiled `configuredConcepts` are `{ key, aliases }` with aliases as unordered peers. Miner-internal expansion comparison is unchanged and has no runtime privilege. `compileCorpus()` returns `configuredConcepts` and `configuredConceptArtifact` directly; `dictionaryEntriesFromEquivalences` is removed.

### Added

- `@software-land/search/corpus` exports `reconcileExternalConfiguredConcepts` and `ExternalConfiguredConceptError` for untrusted/generated configured-concept candidate rows. The helper clusters compatible duplicates, records unresolved ambiguity or conflict, and projects accepted identities to `configuredConcepts: ConfiguredConcept[]` (aliases are unordered peers; serialization may sort forms with no ranking meaning) plus review metadata (`rejected`, `conflicts`, `unresolved`, `reconciliations`). Candidate `expansion` is miner/review provenance and is not a privileged `ConfiguredConcept` field. Stale fields `primary`, `standaloneRecall`, and `topicalRecall` are rejected; use `migrateConfiguredEntry()` for 0.4 rows and `relationshipMap` `kind: "related"` for related recall. The compiler does not call a model and does not accept a multi-sense `expansions: []` public schema.
- Authored `relationshipMap` `equivalent` edges are directional one-hop recall. They do not auto-reverse. `compileAuthoredRelevance()` installs that recall in `authored.plugins`; there is no separate root `synonyms()` application-authoring API. Lookup may use a unique configured key/span, an exact lexical phrase source, or uncovered tokens. It does not rewrite typed identity, lexical intent, or configured occupancy, and it does not activate topical or standalone recall. Trusted corpus-mined synonym groups compile to a full bidirectional equivalent clique on `relationshipMap` (a group `{ terms: ["a","b","c"] }` emits every ordered pair). Review metadata stays on inspection/decisions, not on runtime edges. Equivalent relevance is authored only through `relationshipMap` `kind: "equivalent"`.
- `mergeRelationships(base, extra)` merges two `search-v2-relationships` artifacts without mutating caller objects. Same source/target/type keeps the first edge. Use it when combining generated semantic neighbors with `authored.documentRelationships`. When there is no generated artifact, pass `authored.documentRelationships` to `SearchEngine.create`.
- Safe symbolic / compact-key normalization: separator punctuation between alphanumeric groups folds (`CI/CD` → `cicd`, `TCP/IP` → `tcpip`). Significant symbols are not silently collapsed (`A*`, `C++`, `C#`, `O(1)`). Spoken expansions such as `C++` → `c plus plus` and `C#` → `c sharp` are kept; unsupported symbolic structures reject rather than collapsing to `c` / `on`.
- External configured-concept reconciliation treats British/American suffix spelling (`acknowledgement`/`acknowledgment`, `colour`/`color`, `optimisation`/`optimization`) and conservative short-form abbreviations of an aligned longer token (`tech`/`technical`) as compatible. Distinct meanings (`authentication`/`authorization`, continuous delivery vs continuous deployment) stay unresolved. The pairwise expansion classifier is an internal helper, not a `@software-land/search/corpus` export.
- Contextual lexical completion from trusted configured peer forms. Typed identity stays typed; concept-level ranking identity is the unordered peer-form set. Ambiguous peer completions fail closed. Explain/query diagnostics may add `contextualCompletion`, `lexicalTokens`, and `lexicalPhraseKey` without changing `search()` result semantics.
- Configured sequence occupancy for a complete typed query: the key sequence and every alias compile as equal non-key `form` sequences (including safe non-final prefixes and unique last-token stubs). Alias array order has no occupancy or ranking effect. A unique whole-query exact configured key occupies that concept even when another concept lists the same typed token as a one-token alias. One-token aliases that are members of a longer peer form occupy only on exact typed identity; they do not occupy from an arbitrary prefix. Multi-token configured forms may still complete an incomplete final token when preceding context uniquely identifies the concept. Incomplete configured-key guessing remains subject to the existing short-prefix information bound. After unique occupancy, ranking reduces over the unordered peer forms so every unambiguous key/alias spelling of one concept produces identical ranked results. Occupied ranking does not concatenate aliases into one synthetic query; each peer form is scored independently. Unique occupancy is not matched-form completeness. Distinct matching concept keys, and ambiguous peer-form completions, fail closed.
- `related` edges compiled by `compileAuthoredRelevance()`: token→concept can broaden retrieval for exact literal queries (runtime/explain provenance standalone-recall); concept→form can retrieve related topical phrases from trusted configured concepts without rewriting query tokens, lexical intent, or `configuredSequenceIntent` (provenance topical-recall). Unique exact configured subspans may activate topical recall when remaining tokens are already stop words and whole-query configured sequence intent is absent. Incomplete/prefix spans, non-stop remainders, and distinct multi-key spans fail closed. Indexed unread-block skipping does not apply to these recall classes.
- Additive explain diagnostics `configuredSpans` (exact configured windows) and occupancy via unique incomplete configured subspans (`configuredPrefixSpans`) when a bounded n≥2 window uniquely aligns under existing prefix-alignment rules, remaining tokens are already stop words, and whole-query intent is absent. They do not rewrite typed identity, do not become `configuredSequenceIntent`, and do not activate topical recall. One-token prefixes, exact windows, non-stop remainders, and distinct multi-key windows fail closed. These spans are not query identity.
- A two-character title-token prefix may admit candidates when the final typed token has normalized length 2, is nonnumeric, is not already a stop word, and every other typed token is already a stop word. Matching is title-token `startsWith` only; query identity is unchanged. Existing ≥3 title-token-prefix, body-prefix, `allowPrefixMatch`, and configured-prefix thresholds are unchanged. One-character prefixes stay closed.
- Unique contextual form completion binds the trailing typed token to one configured form word. The leftover incomplete stub stays on the query for explain and does not independently donate unbound title evidence. Exact typed identity with the completed word or its canonical lemma is not consumed.
- Indexed exact multi-token `search()` can skip noncompetitive unread body-posting blocks while preserving exhaustive compiled-search results on that supported query class. Additive `exact-pruning-v2` body-presence metadata on the lexical index; older artifacts remain valid. `searchDetailed()`, prefix, repaired, configured-concept occupancy, numeric, custom-constraint, and other unsupported paths use the existing exhaustive path. No new public `SearchEngine` method. Measured work reduction is documented in `docs/scaling.md` and is not an SLA.
- Deterministic corpus mining extracts a digit-prefixed acronym suffix only when that suffix is independently observed in the same document as a standalone acronym surface or as an independent token. A compound such as `2FA` does not become `FA` without independent `FA`/`fa` evidence. Within-document repeats remain candidate evidence. These paths do not invent keys from arbitrary phrases and do not loosen short-token auto-accept.

### Fixed

- Non-occupied configured prefix attachments no longer stamp `configuredFormCoverage` onto candidates or promote unigram body matches to moderate direct class. Occupied matched-form completeness is unchanged. Contextual title-prefix classification is unchanged.
- Indexed and compiled retrieval preserve full-scan prefix recall for recall-derived forms. Unambiguous configured-form prefixes that already meet the occupancy information bound keep their intended direct-evidence class: a 2/3 exact left prefix of a uniquely resolved form is moderate, not merely weak body overlap, and `configuredFormCoverage` remains the true 2/3 completeness. The existing prefix information bound is unchanged.
- Compiled equivalent recall authored on a single-token inflected form remains reachable from that form's canonical lemma-table identity. Lookup is built once at plugin bind from `canonicalLemma` only; heuristic suffix stems are not used. Exact authored keys stay authoritative. Distinct target sets that collapse to the same lemma fail closed. Authored maps are not mutated, reversed, or expanded with a derived lemma key. Multi-token morphology folding is unchanged.
- Related neighbors no longer forcibly outrank a weak-direct candidate that already has repeated compiled body-phrase evidence, or whose body matches a directed target from ordinary same-concept equivalent recall. Those pairs stay unordered so ordinary score can prefer either side. Weak-direct class is unchanged. The candidate-local `ordinaryEquivalenceBodyMatch` flag is provenance only: it adds no score and does not change coverage or direct class.
- A document whose body lexically evidences every coverage concept outranks a weak/none document whose title∪body lexical evidence covers only a strict subset, when the query has at least two coverage concepts. `queryCoverage` stays title-only and `bodyLexicalMatch` stays body-only. The union is a separate `lexicalConceptCoverage` explain feature. Direct class is unchanged.
- Configured form/alias alignment may skip interior typed stop words (`of`, `and`) without rewriting typed surface or stripping stops from the query representation. The last typed content token may use the existing last-token prefix rules. A unique form suffix of at least three content tokens may occupy when it includes the final form token. An explicit unique 1-token form-word alias occupies whole-query configured intent on exact typed identity only. Prefix stubs, interior spans, colliding aliases, one-token fragments, and non-stop gaps fail closed.
- Compact significant-symbol query tokens now project their spoken lexical phrase as a retrieval alternative of the same typed concept. The existing operator map (`*` → star, `+` → plus, `#` → sharp) is reused. Typed surface is unchanged (`a*` stays `a*`) while the spoken phrase (`a star`) can match a title tokenized as those words. Compiled equivalent recall on the same typed concept is unchanged. Bare punctuation and ordinary separators are not spoken-expanded.
- Unknown query tokens are repaired individually after tokenization: exact compound segmentation may split a glued token inside a multi-token query, and typo correction may use morphology lemma-table keys as well as title/dictionary vocabulary. Typed `surface` / `originalSurface` stay what the user typed. Lemma keys join the existing bounded typo candidate set (length-band ±2, edit distance ≤ 2) and do not scan documents. Known words, configured keys, confident lemmas, and title/dictionary prefixes are not rewritten here.
- A valid morphology lemma may occupy an exact configured key (`apis` → `api`) without rewriting typed surface, using typo alternatives, or looking up keys fuzzily. Unique n≥2 left-prefixes of a configured peer form set `configuredSequenceIntent`. Ambiguous one-token first-word prefixes occupy the unique longest matching form and fail closed on same-length ties; unique configured-key prefixes stay on the existing key-prefix path. Wrapped stop remainders reuse the same occupancy.
- Extra concepts attached after configured occupancy from compiled equivalent recall no longer count as typed/configured lexical coverage. `queryCoverage`, `bodyLexicalMatch`, and title `formSet` use the real query concept set. Retrieval source is `equivalent-recall`. Explain features `equivalentRecallMatch` / `equivalentRecallTitleMatch` / `equivalentRecallBodyMatch` / `equivalentRecallScore` expose recall quality. Constraints `literal-over-equivalent-recall` and `equivalent-title-over-equivalent-body` rank identity evidence above equivalent-only recall, and equivalent-recall title above equivalent-recall body. Ordinary uncovered-term equivalent forms remain merged into the same term concept and are unchanged.
- Authored `relationshipMap` sources and compiled equivalent-recall keys are stored on prototype-free records. Ordinary inherited names such as `toString` compile as data. Whitespace-normalized `__proto__` / `prototype` / `constructor` are rejected after the same trim used for the key.
- Browser `SearchClient` / Worker initialization compiles `relationshipMap` with the same authored-relevance semantics as in-process `compileAuthoredRelevance()`, so equivalent, standalone, topical, and editorial edges are not silently dropped. `createWorkerRuntime({ compileConfiguredConceptPlugin })` is invoked for custom hosts when init has no `relationshipMap`. `documents` stays on the `compileAuthoredRelevance()` path. `relationshipMap` still requires the full authored-relevance compiler; a configured-concept-only custom host with `relationshipMap` fails closed instead of dropping equivalent or editorial edges.

### Changed

- Title-prefix scoring excludes a concept form that is a proper prefix of another form in the same concept, so a morphology-derived lemma cannot prefix-match a longer unrelated title token. Independent exact and lemma token matches still use the full form bag.
- Weak single-token body-frequency remains a last-resort within-class tie-break: it applies only to one-token queries among otherwise equivalent weak or none body-lexical hits, after score. It is not a score term and does not attach, occupy, or promote configured concepts.

### Security

- CI workflow permissions are `contents: read`. Document-path `#` stripping is index-based rather than a greedy regular expression. The published package has no model/provider adapters, API-key configuration, or enrichment orchestration.

## 0.4.0

### Breaking

- Public `english()` is removed. Canonical morphology is `morphology({ lemmas? }) => EnglishPlugin`. Plugin `name` remains `"english"`. Internal `createEnglishPlugin` / `english()` stay unpublished. Worker `init({ englishOptions })` is unchanged.
- `SearchEngine.create({ plugins })` is `SearchPlugin[]` rather than `unknown[]`. `dictionary()` returns `DictionaryPlugin`. Custom retrievers are `ExperimentalRetriever` rather than `{ retrieve: Function }`. Runtime still duck-types plugin objects and custom `retrieve` functions.
- Default `SearchEngine.create()` retrieval is `indexed` rather than `full-scan`. `indexed` now means exact compiled lexical retrieval: all legitimate matches are enumerated and exact representatives are selected by builtin constraint signature. `candidateLimit` remains accepted for compatibility but is not an exactness bound. Explicit `retriever: "full-scan" | "indexed" | "adaptive"` and custom `ExperimentalRetriever` objects remain available.

### Added

- Preferred public morphology factory `morphology({ lemmas })`, typed as `(options?: MorphologyOptions) => EnglishPlugin`. `MorphologyOptions` is `{ lemmas?: Record<string, string> }`, parallel to `dictionary({ entries })`. Plugin `name` stays `"english"`. Worker `init({ englishOptions })` is unchanged.
- Candidate-stage survival checks: expected ranking-contract targets must appear in `meta.candidateTitles` before ranking, on both full-scan and indexed retrieval. Short numeric queries still keep short-literal and dotted-span title matches in the candidate set rather than dropping them under high-TF body pressure.
- Identity-preserving sparse ranking for builtin constraint functions: candidates are grouped by constraint-relevant signatures, compared at the signature/bucket layer, and ordered with a heap over ready buckets. Same-class conflicts stay unordered. Incomparable buckets still interleave by score then `document.id`. Complete bipartite candidate edges are not materialized. Custom `ConstraintDef.fn` values still use the all-pairs path. Public ranking API is unchanged.
- Development-only ranking, feature-extraction, and retrieval-mode harnesses under `benchmarks/` (fixed candidate sizes, synthetic mixed workloads, frozen oracle comparison). Not packed. Not a search-quality claim. Not a CI latency gate.
- Deterministic `search-v2-lexical-index` v1 compilation under the existing `@software-land/search/lexical` entry point. Its unified positional streams hydrate exact lookup and compact query-time document views, with document/version metadata, compact surface→lemma ownership, corpus statistics, and compatibility/integrity fingerprints but no duplicated raw title/body or lexical-frequency maps.
- Narrow `SearchEngine.create({ lexicalIndex })` and Worker `init({ lexicalIndex })` inputs. Omission builds the equivalent exact structure once during `index()`; an invalid supplied artifact rejects instead of falling back.
- Exact compiled match enumeration and current-feature reconstruction with zero raw-document scans for supplied artifacts. Stage 1 deliberately has no WAND, MaxScore, block skipping, posting early termination, or approximate prefix truncation.
- Proven ordered top-R-per-builtin-signature selection for coherent query features, using the same rounded final score then `document.id` as the ranker and preserving first-seen signature order, same-class conflicts, and builtin SCCs. The complete featured map survives relationship target handling; channels derive a deeper prefix when required to preserve public absolute ranks and `constraintsVsNext`. Unknown custom constraints fail closed to all candidates.
- Additive integrity-covered `exact-pruning-v1` document-ordinal boundaries under the existing lexical-index v1 extension namespace. Older v1 artifacts remain exact/exhaustive; malformed or unsupported claimed pruning metadata rejects.
- Exact Stage-2A document-feature block pruning for proven plain single-token body-only candidates. It preserves per-signature rounded-score/id prefixes, keeps an internal exhaustive compiled oracle, and exposes experimental visited/rejected/fallback counters. Posting enumeration remains exhaustive except for Stage-2B identical posting-array rewalks.
- Exact Stage-2B skip of posting arrays this query has already fully walked (duplicate token/concept/lemma/contextual lanes) when `retrievalScoreWeight` is `0`. Membership, provenance, and default ranking stay Stage-1 exact. Unread posting blocks, prefix expansions, and nonzero retrieval-score reconstruction stay exhaustive. No new lexical-index version or pruning extension.
- Compact compiled lexical runtime: interned term ids, packed token/offset views, and query-time document accessors instead of reconstructing per-document token/lemma arrays, Sets, and position Maps. `search-v2-lexical-index` v1 bytes and public search semantics are unchanged. Full-scan may keep fat objects. See `docs/compact-runtime.md`.
- Compact phrase adjacency, title-concept, and body-concept checks read packed token ids instead of `PackedTokenProxy` hot loops. Feature vectors and ranking are unchanged.
- `SECURITY.md` and `CONTRIBUTING.md`.

### Fixed

- Query analysis applies an explicit lemma-table identity (built-in or caller-supplied) before edit-distance typo-correction. A same-distance vocabulary neighbor does not rewrite a surface that already has an editorial mapping.
- Indexed retrieval was dropping ranking-critical `title-prefix` / short-literal winners when more than `candidateLimit` high-TF body matches existed. `title-prefix` is now a capped must-keep, same `prefixCap` bound as contextual title-prefix. Ranking features and constraint semantics are unchanged.
- Exact indexed retrieval no longer drops full-scan winners that occur below the old BM25-ish top-200 admission pool.

### Changed

- Builtin ranking no longer examines every candidate pair in the common case. Complexity is O(C log C + B²F + E_b) when the discrete signature count B is small, plus a localized pairwise fallback of size k when custom constraints are used (k = C). Worst case remains Θ(C²) when B = C or every constraint function is custom. This is not a claim of strict O(C log C) for every workload, of 5 ms search on all hardware, or of large-corpus full-scan scalability.
- Feature extraction caches query-local prep, bounds typo distance, and reuses in-memory independent-title and long-body token indexes. Ranking semantics, scores, constraints, explanations, candidates, and current query results are unchanged.
- Indexed retrieval now compiles/loads exact positional statistics, enumerates all legitimate matches, reconstructs the unchanged features, keeps exact per-signature representatives, and invokes the existing sparse ranker. `candidateLimit` is not used to truncate the exact path. Stage 1 remains Θ(matches) in posting/feature work and does not claim a fixed hard C bound, strict subquadratic worst case, a universal 5 ms high-DF target, or final memory layout.
- Normal indexed/Worker result paths may omit full feature extraction for a block only when the exact reachable body-only signature, rounded score, and minimum-id tie bound prove that no member can enter the required representative stream. Multi-term/prefix/configured/version uncertainty, nonzero retrieval-score weight, full diagnostics, `all-strong`, active relationship expansion, custom/unknown ranking, and old artifacts fail closed to exhaustive Stage-1 evaluation. No WAND, MaxScore, posting-entry skipping, or approximate matching is introduced.
- Public `searchDetailed()` retains full candidate-title, cycle, conflict, related-count, global-rank, and explanation-successor semantics through an exact full diagnostic plan. Normal `search()`/`searchAsync()` and Worker results remain on the representative path.
- Worker result `meta` now forwards only high-level timings and counts (`totalMs`, `retrieveMs`, `featureMs`, `selectionMs`, `rankMs`, `candidateCount`, `matchCount`, `relatedCount`, `relationshipStrategy`). Stage-2 posting/block/pruning counters remain on `searchDetailed()` / `lastSearchMeta` and an internal Worker diagnostics switch. `_exactPruningMode` is an internal Worker init field, not part of `SearchClient.init`.
- `SearchClient.init({ retriever })` accepts only Worker-safe retriever names (`RetrieverName | "indexed-lexical"`). Function-bearing `ExperimentalRetriever` objects remain valid on `SearchEngine.create` and cannot typecheck on Worker init, because `init` forwards the payload through `postMessage`.
- Site lemma generation is documented as build-time data. This package consumes a `Record<string, string>`, not the generator itself. Site-specific lemma tooling is not a runtime or general-purpose dependency of Search Core.

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

- A standalone all-digit query token is not independent exact-title evidence merely because it appears as a component of a dotted numeric title span (the `2` in `1.2`). Short-literal lead-title matches still outrank that weak dotted-span overlap.
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

This patch does not retune ranking, change artifact format versions, add a query-time model/vector/LLM dependency, change the Worker protocol, or break the public API.

## 0.2.2

### Fixed

- Compact version companions now use the repaired typed token for typed-completeness evidence, so inferred unique-prefix completion cannot satisfy short version-companion queries.

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
- Typed/repaired surface stays observable as `surfaceNormalized` and `typedSurfaceTitleMatch` after canonical retrieval rewrite. For single-token queries, exact typed surface-title agreement outranks lemma-only title matches. Multi-token phrase identity is unchanged.
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
