# Software.Land search fixture

Software.Land-derived realistic integration test data. It is not default package policy.

See `NOTICE.md` in this directory: Software.Land editorial/body content is not
Apache-2.0 licensed merely because it lives in this repository.

This directory is a frozen snapshot of live V2 `SearchEngine` inputs from the
Software.Land application. It exists so `@software-land/search` can exercise
production-derived ranking in this OSS repo without importing Gatsby, UI, V1,
or the Software.Land E2E runner.

Lemmas and dictionary/equivalence entries here are **fixture arguments only**.
They must be passed into `morphology({ lemmas })` and `dictionary({ entries })`.
There is no public root `english()` helper; Worker initialization passes the same
lemma map through `englishOptions`.
They must never become Core defaults.

## Provenance

| Field | Value |
| --- | --- |
| Fixture format | `software-land-search-fixture` v1 (`manifest.json`) |
| Corpus source commit | `dff24cf606967cb50b24d28d9142747c9203e053` |
| Scenario source commit | `08e1b735ae01a3815964360ef3b9141466176dc4` |
| `@software-land/search` | `0.3.1` |
| Documents | 122 |
| Source scenarios | `tests/search-scenarios.js` (215 rows) + `tests/search-v2-contracts.js` (16) |
| Strict V2 contracts | 98 (`v2-contracts.json`) |
| B-intent regressions | 60 (`regression-scenarios.json`, compatibility coverage, not Core policy) |
| Historical inventory | 215 rows (`historical-scenarios.json`); 214 executable relevance contracts |
| Historical relevance config | `relevance-config.json` + `synonym-map.json` (Software.Land `eac7a90a15d772f0f0626a0fa9481eb9efa55521`) |
| Omitted empty-intent rows | 44 (not mined into V2 intent/regression; still in historical relevance) |
| Omitted V1-only source rows | 126 (B + A without intent; some re-enter as regressions; still in historical relevance when `expectedTop` exists) |
| Omitted browser/UI-only | 1 (`zzz-no-hit` no-results copy) |
| Omitted historical relevance | 1 (`sharde`, classification C obsolete) |

Corpus artifacts come from a clean Software.Land worktree at
`dff24cf606967cb50b24d28d9142747c9203e053`. Scenario policy comes from the
committed Software.Land tree at `08e1b735ae01a3815964360ef3b9141466176dc4`
(parent of that commit is the corpus SHA). Strict V2 contracts are A-class
independent intent plus `SEARCH_V2_CONTRACTS`. Regression cases reuse recorded
B-class independent intent as Software.Land compatibility coverage; they are
**not Core ranking policy**. Historical `expectedTop` / `titlePrefix` / `topN`
are executable Software.Land relevance contracts in
`test/software-land-historical-relevance.test.js` (membership within topN, not
exact order). Classification C is omitted. That suite is not the exact-output
oracle and not Core default ranking policy. The relevance engine loads curated
synonyms from `synonym-map.json`, omits the `testing` dictionary key, and patches
AppSec aliases/`topicalRecall` from `relevance-config.json`, matching
Software.Land commit `eac7a90a15d772f0f0626a0fa9481eb9efa55521`
(`src/search/synonymMap.js` plus committed `appsec.topicalRecall`; no auto-reverse).
Corpus artifacts and the exact-output `dictionary.json` snapshot are unchanged. Empty-intent rows
are not mined into V2 intent/regression cases; they still participate in
historical relevance when `expectedTop` or `titlePrefix` exist.

Do not snapshot corpus artifacts from a dirty Software.Land worktree. Do not
generate scenario fixtures from a dirty worktree; extract `tests/search-scenarios.js`
and `tests/search-v2-contracts.js` from the committed scenario SHA.

## Files

- `documents.json` — `id`, `title`, normalized search `body` (live V2 indexed shape)
- `dictionary.json` — merged Software.Land acronym map + compiled equivalences as `dictionary({ entries })`
- `lemmas.json` — site lemma table as `morphology({ lemmas })`
- `relationships.json` — runtime relationship graph, including TLS ↔ VPN editorial edges
- `lexical-frequency.json` — production lexical-frequency artifact
- `v2-contracts.json` — strict accepted V2 cases (`kind: contract`)
- `regression-scenarios.json` — B-intent compatibility coverage, not Core ranking policy
- `historical-scenarios.json` — full 215-row inventory; `v1.expectedTop`/`titlePrefix`/`topN` are executable historical relevance contracts
- `relevance-config.json` — Software.Land 0.5 relevance-engine inputs (omit `testing`, patch AppSec topicalRecall, load synonym map)
- `synonym-map.json` — explicit directional curated synonym map from Software.Land `eac7a90` (`SYNONYM_MAP`; no reverse materialization)
- `scenarios.json` — index, counts, and disposition totals
- `manifest.json` — format, corpus/scenario source commits, package version, document count, scenario provenance, SHA256s

`lexical-frequency.json` is copied from the production artifact. Compiling it
from `documents.json` through `@software-land/search/lexical` is deterministic
and cheap (~200 ms), but it is **not** byte-identical unless the compile-time
body shape (`description + body`) is used. That shape is not what live V2
indexes. Ranking of the compact queries happened to match; the artifact did
not. The snapshot is retained so production semantics stay exact.

## Regeneration

Corpus files: from a clean Software.Land tree at the recorded corpus commit,
after `search:artifacts:compile`:

1. Export live V2 documents (`id` / `title` / `normalizeSearchBody(body)`).
2. Transform `acronymMap.js` + compiled equivalences into `dictionary.json`.
3. Copy `site-lemmas.json` lemmas, `software-land-relationships.json`, and
   `lexical-frequency.json`.

Scenario files: extract policy sources from the committed scenario SHA (not a
dirty worktree), then rebuild fixtures and provenance in `manifest.json` with
the repo-only transform (no Gatsby, UI, or network):

```bash
git -C /path/to/software.land show \
  08e1b735ae01a3815964360ef3b9141466176dc4:tests/search-scenarios.js \
  > /tmp/search-scenarios.js
git -C /path/to/software.land show \
  08e1b735ae01a3815964360ef3b9141466176dc4:tests/search-v2-contracts.js \
  > /tmp/search-v2-contracts.js

node scripts/software-land-scenarios.mjs \
  --scenarios /tmp/search-scenarios.js \
  --contracts /tmp/search-v2-contracts.js \
  --dir test/fixtures/software-land \
  --manifest test/fixtures/software-land/manifest.json
```

Copy `synonym-map.json` from Software.Land committed `SYNONYM_MAP` at the recorded
`relevanceSoftwareLandCommit` after generic OSS `normalizeSearchEquivalences()`.
Patch AppSec dictionary aliases/`topicalRecall` only through `relevance-config.json`;
do not edit frozen `dictionary.json`. Do not reverse-materialize. Do not generate
`expectedTop` / `topN` / `titlePrefix` from current engine output.

Do not run `compileSemantic` in OSS CI. Do not copy models, vectors, markdown
posts, Gatsby code, V1 rankings, or the app E2E runner.
