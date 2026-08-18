# Artifact formats

Runtime artifacts are JSON objects with `format` and `version`. **Version 1 only.** Missing format/version, wrong format, or version ≠ 1 throws (`ArtifactValidationError` / `ArtifactVersionError`). Null/omitted artifacts mean “empty,” not malformed.

| format | version | required | role |
| --- | --- | --- | --- |
| `search-v2-equivalences` | 1 | `entries[]` with `key` | query interpretation |
| `search-v2-synonyms` | 1 | `entries[]` with `terms` (length ≥ 2) | query interpretation |
| `search-v2-relationships` | 1 | `relationships` map of source id → edges | related expansion |
| `search-v2-corpus-stats` | 1 | `stats` object | optional diagnostics |

Unknown fields on a v1 object are ignored (additive). A new integer version is an incompatible schema/semantic change; this runtime will not guess.

Same version: backward-compatible additive changes only. There is no migration framework before 1.0.

Deterministic compile (builders sort ids). `__proto__` / `constructor` / `prototype` keys are ignored when reading relationship maps.

There is **no** finalized lexical-index artifact. Indexed retrieval currently builds postings at `index()` time.

Pass parsed objects into `dictionary({ entries })` or `SearchEngine.create({ relationships })`.
