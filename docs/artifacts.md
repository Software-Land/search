# Artifact formats

Versioned artifacts are JSON objects with `format` and `version`. **Version 1 only.** Missing format/version, wrong format, or version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted query artifacts mean “empty”; an omitted lexical index instead selects exact runtime construction during `index()`. A malformed supplied lexical index always throws.

Artifact format/version identifiers are independent of the npm package version. For example, `@software-land/search` 0.4.0 can consume artifacts with `version: 1`. Literal names such as `search-v2-relationships` and `search-v2-lexical-index` are artifact format identifiers, not package-version labels.

| format | version | required | role |
| --- | --- | --- | --- |
| `search-v2-configured-concepts` | 1 | `entries[]` with `key` | corpus/tooling configured concepts (`ConfiguredConcept` rows `{ key, aliases }`) |
| `search-v2-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-v2-corpus-stats` | 1 | `stats` object | optional diagnostics |
| `search-v2-lexical-frequency` | 1 | n-gram policy and per-document maps | build-time artifact attached to documents |
| `search-v2-lexical-index` | 1 | compatibility/corpus/integrity headers plus opaque positional data | exact compiled retrieval |

Equivalent recall is not a separate versioned artifact. Author directional `equivalent` edges on `relationshipMap` and compile them with `compileAuthoredRelevance()`. The corpus compiler writes generated equivalent edges as `relationship-map.json`, mergeable into an application-owned `relationshipMap`. There is no `search-v2-synonyms` format and no `parseSynonyms()`. The configured-concept artifact is corpus/tooling output (`@software-land/search/corpus`); applications normally pass `ConfiguredConcept[]` into `compileAuthoredRelevance({ configuredConcepts })`.

Unknown fields on a version-1 artifact are ignored (additive). A new integer version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

`search-v2-lexical-index` version 1 is the finalized Stage-1 compiled contract, not the earlier postings-only experiment. It is compiled by `@software-land/search/lexical` and stores the query-independent positional/analyzed state needed to hydrate exact lookup without raw title/body analysis. Raw searchable text and separately owned lexical-frequency data remain in the supplied documents and are bound by the corpus fingerprint. A custom document lemma plugin requires a deterministic `indexIdentity`; unverifiable supplied artifacts reject.

Its opaque payload has an integrity-covered additive extension namespace. New compilers emit `exact-pruning-v1` (128-document ordinal boundaries for Stage 2A) and `exact-pruning-v2` (per-term body presence masks on that same grid for Stage 3A). Missing metadata on an older version-1 lexical-index artifact selects exhaustive Stage-1/3A behavior. Malformed or unsupported claimed pruning metadata rejects. Stage 2A does not skip posting entries. Stage 2B skips identical already-walked posting arrays at query time without a new artifact extension. Stage 3A may skip unread 1-of-k body ordinals when v2 presence bits prove they cannot enter a saturated representative stream. On the measured VPN-like corpora, v2 metadata was about 964 KB / 7.4% of a ~13.1 MB 25k artifact and about 3.89 MB / 7.2% of a ~54.0 MB 100k artifact; those sizes are machine measurements, not an SLA. An incompatible core representation still requires a new artifact version. See [scaling.md](scaling.md).

`search-v2-lexical-frequency` remains a separate build artifact. Apply it to source documents with `attachLexicalFrequency()` before compiling or loading the lexical index. The lexical index fingerprints that attached data but does not serialize a second copy.

After successful `index()`, `SearchEngine` retains only the compact runtime state and a small compatibility header; it drops its own reference to the supplied envelope and parsed document tuples. The caller still owns any artifact object it retained and may release it after initialization (or after Worker `ready`). Re-indexing the identical validated corpus reuses the hydrated state. Incompatible replacement documents reject instead of rebuilding or silently falling back.

See [compact-runtime.md](compact-runtime.md) for the Stage-2C packed document view. No lexical-index version bump is required for that runtime change.

Pass parsed configured concepts into `compileAuthoredRelevance({ configuredConcepts })`, generated or authored `relationshipMap` equivalent/related edges into `compileAuthoredRelevance({ relationshipMap })`, parsed relationship graphs into `SearchEngine.create({ documentRelationships })`, and parsed lexical indexes into `SearchEngine.create({ lexicalIndex })`. The `search-v2-relationships` artifact still stores its graph under the inner `relationships` map; that is the persisted artifact payload, not the SearchEngine option name.
