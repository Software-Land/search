# Artifact formats

Runtime artifacts are JSON objects with `format` and `version`. **Version 1 only.** Missing format/version, wrong format, or version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted artifacts mean “empty,” not malformed.

| format | version | required | role |
| --- | --- | --- | --- |
| `search-v2-equivalences` | 1 | `entries[]` with `key` | query interpretation |
| `search-v2-synonyms` | 1 | `entries[]` with `terms` (length ≥ 2) | query interpretation |
| `search-v2-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-v2-corpus-stats` | 1 | `stats` object | optional diagnostics |
| `search-v2-lexical-index` | 1 | compatibility/corpus/integrity headers plus opaque positional data | exact compiled retrieval |

Unknown fields on a v1 object are ignored (additive). A new integer version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

`search-v2-lexical-index` v1 is compiled by `@software-land/search/lexical`. It stores the query-independent positional/analyzed state needed to hydrate exact lookup without raw title/body analysis. Raw searchable text and separately owned lexical-frequency data remain in the supplied documents and are bound by the corpus fingerprint. A custom document lemma plugin requires a deterministic `indexIdentity`; unverifiable supplied artifacts reject.

Its opaque payload reserves an integrity-covered extension namespace. Stage 1 leaves it empty and performs no posting pruning. Future exact block-bound data may be additive there; an incompatible core representation requires a new artifact version.

Pass parsed objects into `dictionary({ entries })`, `SearchEngine.create({ relationships })`, or `SearchEngine.create({ lexicalIndex })` as appropriate.
