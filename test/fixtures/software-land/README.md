# Software.Land search fixture

Software.Land-derived realistic integration test data. It is not default package policy.

See `NOTICE.md` in this directory: Software.Land editorial/body content is not
Apache-2.0 licensed merely because it lives in this repository.

This directory is a frozen snapshot of live V2 `SearchEngine` inputs from the
Software.Land application. It exists so `@software-land/search` can exercise
production-derived ranking in this OSS repo without importing Gatsby, UI, V1,
or the Software.Land E2E runner.

Lemmas and dictionary/equivalence entries here are **fixture arguments only**.
They must be passed into `english({ lemmas })` and `dictionary({ entries })`.
They must never become Core defaults.

## Provenance

| Field | Value |
| --- | --- |
| Fixture format | `software-land-search-fixture` v1 (`manifest.json`) |
| Software.Land source commit | `dff24cf606967cb50b24d28d9142747c9203e053` |
| Source | clean Software.Land worktree at `dff24cf606967cb50b24d28d9142747c9203e053` |
| `@software-land/search` | `0.3.1` |
| Documents | 122 |

Do not snapshot from a dirty Software.Land worktree.

## Files

- `documents.json` — `id`, `title`, normalized search `body` (live V2 indexed shape)
- `dictionary.json` — merged Software.Land acronym map + compiled equivalences as `dictionary({ entries })`
- `lemmas.json` — site lemma table as `english({ lemmas })`
- `relationships.json` — runtime relationship graph, including TLS ↔ VPN editorial edges
- `lexical-frequency.json` — production lexical-frequency artifact
- `scenarios.json` — compact accepted V2 assertions
- `manifest.json` — format, source commit, package version, document count, SHA256s

`lexical-frequency.json` is copied from the production artifact. Compiling it
from `documents.json` through `@software-land/search/lexical` is deterministic
and cheap (~200 ms), but it is **not** byte-identical unless the compile-time
body shape (`description + body`) is used. That shape is not what live V2
indexes. Ranking of the compact queries happened to match; the artifact did
not. The snapshot is retained so production semantics stay exact.

## Regeneration

From a clean Software.Land tree at the recorded commit, after
`search:artifacts:compile`:

1. Export live V2 documents (`id` / `title` / `normalizeSearchBody(body)`).
2. Transform `acronymMap.js` + compiled equivalences into `dictionary.json`.
3. Copy `site-lemmas.json` lemmas, `software-land-relationships.json`, and
   `lexical-frequency.json`.
4. Refresh SHA256s in `manifest.json`.

Do not run `compileSemantic` in OSS CI. Do not copy models, vectors, markdown
posts, Gatsby code, or the app E2E matrix.
