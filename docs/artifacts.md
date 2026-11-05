# Artifact formats

Versioned artifacts are JSON objects with a `format` identifier and a schema `version`. **Schema version 1 only.** Missing format or schema version, the wrong format, or schema version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted query artifacts mean “empty”; an omitted lexical index instead selects exact runtime construction during `index()`. A malformed supplied lexical index always throws.

A format identifier is not the schema version and is not the npm package version. `{ "format": "search-relationships", "version": 1 }` is a `search-relationships` artifact with schema version 1. The same distinction applies to every family in the table below. Each accepted artifact uses schema version 1. Package 0.4.0 wrote and read the older `search-v2-*` spellings; it cannot be assumed to read the identifiers in this table. See [Format compatibility](#format-compatibility).

| format | version | required | role |
| --- | --- | --- | --- |
| `search-configured-concepts` | 1 | `entries[]` with `key` | corpus/tooling configured concepts (`ConfiguredConcept` rows `{ key, aliases }`) |
| `search-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-corpus-stats` | 1 | `stats` object | optional diagnostics |
| `search-lexical-frequency` | 1 | n-gram policy and per-document maps | build-time artifact attached to documents |
| `search-lexical-index` | 1 | compatibility/corpus/integrity headers plus opaque positional data | exact compiled retrieval |
| `search-vocabulary` | 1 | `terms[]` | corpus spelling/domain terms (`spellingTerms()` reads `terms` and does not dispatch on `format`) |

Equivalent recall is not a separate versioned artifact. Author directional `equivalent` edges on `relationshipMap` and compile them with `compileAuthoredRelevance()`. The corpus compiler writes generated equivalent edges as `relationship-map.json`, mergeable into an application-owned `relationshipMap`. There is no `search-v2-synonyms` format and no `parseSynonyms()`. The configured-concept artifact is corpus/tooling output (`@software-land/search/corpus`); applications normally pass `ConfiguredConcept[]` into `compileAuthoredRelevance({ configuredConcepts })`.

Unknown fields on an artifact with schema version 1 are ignored (additive). A new integer schema version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

A `search-lexical-index` artifact with schema version 1 is the exact compiled retrieval contract, not the earlier postings-only experiment. It is compiled by `@software-land/search/lexical` and stores the query-independent positional/analyzed state needed to hydrate exact lookup without raw title/body analysis. Raw searchable text and separately owned lexical-frequency data remain in the supplied documents and are bound by the corpus fingerprint. A custom document lemma plugin requires a deterministic `indexIdentity`; unverifiable supplied artifacts reject.

Its opaque payload has an integrity-covered additive extension namespace. Current compilers emit `exact-pruning-block-boundaries` (128-document ordinal boundaries for feature block pruning) and `exact-pruning-body-term-masks` (per-term body presence masks on that same grid for body posting pruning). Those names are extension identifiers. Each payload revision stays 1. The lexical schema version stays 1. None of those numbers is the npm package version. 0.8.0 also reads the explicit legacy aliases `exact-pruning-v1` and `exact-pruning-v2`, one alias per family. A mixture across the two families is accepted. Both spellings of one family are rejected. Integrity is verified on the incoming bytes before either alias is resolved, and the returned artifact keeps those bytes. Missing metadata on an older `search-lexical-index` artifact with schema version 1 selects exhaustive behavior for the missing family. Malformed or unsupported claimed pruning metadata rejects under either spelling. Feature block pruning does not skip posting entries, and it does not run for `searchDetailed()` or for `search()` queries that packed ranking evidence already handles. Duplicate posting-list skipping avoids another walk of an identical posting array already visited during the same query, without a new artifact extension. Body posting pruning may skip unread 1-of-k body ordinals on the supported exact multi-token `search()` path when body-term-mask bits prove they cannot enter a saturated representative stream. The 0.6.1 VPN-like measurements recorded about 964 KB / 7.4% of a ~13.1 MB 25k artifact and about 3.89 MB / 7.2% of a ~54.0 MB 100k artifact for the historical `exact-pruning-v2` key; those sizes are machine measurements, not an SLA, and they are not a size promise for the longer canonical key. Package versions before 0.8.0 are not guaranteed to read the extension names 0.8.0 writes. 0.6.5 fused ranking evidence is runtime-only: it does not add a lexical-artifact extension, compound-state payload, or public `compoundAcceleration` option. An incompatible core representation still requires a new artifact version. See [scaling.md](scaling.md) and [exact-pruning.md](exact-pruning.md).

`search-lexical-frequency` remains a separate build artifact. Apply it to source documents with `attachLexicalFrequency()` before compiling or loading the lexical index. The lexical index fingerprints that attached data but does not serialize a second copy.

After successful `index()`, `SearchEngine` retains only the compact runtime state and a small compatibility header; it drops its own reference to the supplied envelope and parsed document tuples. The caller still owns any artifact object it retained and may release it after initialization (or after Worker `ready`). Re-indexing the identical validated corpus reuses the hydrated state. Incompatible replacement documents reject instead of rebuilding or silently falling back.

See [compact-runtime.md](compact-runtime.md) for the compact lexical runtime. That runtime change does not bump the `search-lexical-index` schema version.

Pass parsed configured concepts into `compileAuthoredRelevance({ configuredConcepts })`, generated or authored `relationshipMap` equivalent/related edges into `compileAuthoredRelevance({ relationshipMap })`, parsed relationship graphs into `SearchEngine.create({ documentRelationships })`, and parsed lexical indexes into `SearchEngine.create({ lexicalIndex })`. The `search-relationships` artifact still stores its graph under the inner `relationships` map; that is the persisted artifact payload, not the SearchEngine option name.

## Format compatibility

0.8.0 writes the identifiers in the table. `ARTIFACT_FORMATS`, `LEXICAL_INDEX_FORMAT`, `LEXICAL_FREQUENCY_FORMAT`, and `CONFIGURED_CONCEPT_FORMAT` use those values. Schema version stays 1; this is not schema version 2.

0.8.0 reads those identifiers and the pre-0.8.0 spelling of the same family, with the same validation for the same payload and schema version:

| Written by 0.8.0 | Also read |
| --- | --- |
| `search-relationships` | `search-v2-relationships` |
| `search-lexical-index` | `search-v2-lexical-index` |
| `search-lexical-frequency` | `search-v2-lexical-frequency` |
| `search-configured-concepts` | `search-v2-configured-concepts` |
| `search-corpus-stats` | `search-v2-corpus-stats` |
| `search-vocabulary` | `search-v2-vocabulary` |

Readers normalize a recognized legacy identifier on the object they return. They do not modify the caller-owned artifact. `attachLexicalFrequency()` and `spellingTerms()` copy n-gram maps and trusted terms; they do not reject an identifier. `search-corpus-stats` is the published `ARTIFACT_FORMATS.corpusStats` value. There is no separate corpus-stats parser beyond that shared schema check.

`search-relationships-domain` and `search-semantic-corpus` are unchanged. `search-v2-equivalences`, `search-equivalences`, `search-v2-synonyms`, and `search-synonyms` stay rejected. An unknown identifier is not accepted by deleting `v2` from the string.

Package versions before 0.8.0 are not guaranteed to read the identifiers 0.8.0 writes. Upgrade consumers before giving them newly written artifacts. Embedding-cache keys are unchanged, so an existing vector cache is reused when the relationship artifact is written again under `search-relationships`.
