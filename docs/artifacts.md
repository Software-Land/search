# Artifact formats

Versioned artifacts are JSON objects with `format` and `version`. **Version 1 only.** Missing format/version, wrong format, or version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted query artifacts mean “empty”; an omitted lexical index instead selects exact runtime construction during `index()`. A malformed supplied lexical index always throws.

| format | version | required | role |
| --- | --- | --- | --- |
| `search-v2-equivalences` | 1 | `entries[]` with `key` | query interpretation |
| `search-v2-synonyms` | 1 | `entries[]` with `terms` (length ≥ 2) | query interpretation |
| `search-v2-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-v2-corpus-stats` | 1 | `stats` object | optional diagnostics |
| `search-v2-lexical-frequency` | 1 | n-gram policy and per-document maps | build-time artifact attached to documents |
| `search-v2-lexical-index` | 1 | compatibility/corpus/integrity headers plus opaque positional data | exact compiled retrieval |

Unknown fields on a v1 object are ignored (additive). A new integer version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

`search-v2-lexical-index` v1 is the finalized Stage-1 compiled contract, not the earlier postings-only experiment. It is compiled by `@software-land/search/lexical` and stores the query-independent positional/analyzed state needed to hydrate exact lookup without raw title/body analysis. Raw searchable text and separately owned lexical-frequency data remain in the supplied documents and are bound by the corpus fingerprint. A custom document lemma plugin requires a deterministic `indexIdentity`; unverifiable supplied artifacts reject.

Its opaque payload reserves an integrity-covered extension namespace. Stage 1 leaves it empty and performs no posting pruning. Future exact block-bound data may be additive there; an incompatible core representation requires a new artifact version.

`search-v2-lexical-frequency` remains a separate build artifact. Apply it to source documents with `attachLexicalFrequency()` before compiling or loading the lexical index. The lexical index fingerprints that attached data but does not serialize a second copy.

After successful `index()`, `SearchEngine` retains only the hydrated runtime state and a small compatibility header; it drops its own reference to the supplied envelope and parsed document tuples. The caller still owns any artifact object it retained and may release it after initialization (or after Worker `ready`). Re-indexing the identical validated corpus reuses the hydrated state. Incompatible replacement documents reject instead of rebuilding or silently falling back.

Pass parsed objects into `dictionary({ entries })`, `SearchEngine.create({ relationships })`, or `SearchEngine.create({ lexicalIndex })` as appropriate.
