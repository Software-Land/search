# Artifact formats

Versioned artifacts are JSON objects with `format` and `version`. **Version 1 only.** Missing format/version, wrong format, or version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted query artifacts mean “empty”; an omitted lexical index instead selects exact runtime construction during `index()`. A malformed supplied lexical index always throws.

Artifact format/version identifiers are independent of the npm package version. For example, `@software-land/search` 0.4.0 can consume artifacts with `version: 1`. Literal names such as `search-v2-relationships` and `search-v2-lexical-index` are artifact format identifiers, not package-version labels.

| format | version | required | role |
| --- | --- | --- | --- |
| `search-v2-equivalences` | 1 | `entries[]` with `key` | query interpretation |
| `search-v2-synonyms` | 1 | `entries[]` with `terms` (length ≥ 2) | query interpretation |
| `search-v2-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-v2-corpus-stats` | 1 | `stats` object | optional diagnostics |
| `search-v2-lexical-frequency` | 1 | n-gram policy and per-document maps | build-time artifact attached to documents |
| `search-v2-lexical-index` | 1 | compatibility/corpus/integrity headers plus opaque positional data | exact compiled retrieval |

Unknown fields on a version-1 artifact are ignored (additive). A new integer version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

`search-v2-lexical-index` version 1 is the finalized Stage-1 compiled contract, not the earlier postings-only experiment. It is compiled by `@software-land/search/lexical` and stores the query-independent positional/analyzed state needed to hydrate exact lookup without raw title/body analysis. Raw searchable text and separately owned lexical-frequency data remain in the supplied documents and are bound by the corpus fingerprint. A custom document lemma plugin requires a deterministic `indexIdentity`; unverifiable supplied artifacts reject.

Its opaque payload has an integrity-covered additive extension namespace. New compilers emit `exact-pruning-v1`: revisioned 128-document ordinal boundaries used by the narrow Stage-2A feature-block proof. Missing metadata on an older version-1 lexical-index artifact selects exhaustive Stage-1 behavior. Malformed or unsupported claimed pruning metadata rejects. Stage 2A does not skip posting entries. Stage 2B skips identical already-walked posting arrays at query time without a new artifact extension; unread posting-block summaries remain future additive work if they preserve the core representation, while an incompatible core representation requires a new artifact version.

`search-v2-lexical-frequency` remains a separate build artifact. Apply it to source documents with `attachLexicalFrequency()` before compiling or loading the lexical index. The lexical index fingerprints that attached data but does not serialize a second copy.

After successful `index()`, `SearchEngine` retains only the compact runtime state and a small compatibility header; it drops its own reference to the supplied envelope and parsed document tuples. The caller still owns any artifact object it retained and may release it after initialization (or after Worker `ready`). Re-indexing the identical validated corpus reuses the hydrated state. Incompatible replacement documents reject instead of rebuilding or silently falling back.

See [compact-runtime.md](compact-runtime.md) for the Stage-2C packed document view. No lexical-index version bump is required for that runtime change.

Pass parsed objects into `dictionary({ entries })`, `SearchEngine.create({ relationships })`, or `SearchEngine.create({ lexicalIndex })` as appropriate.
