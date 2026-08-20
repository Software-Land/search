# Changelog

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
