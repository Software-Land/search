# Software.Land search fixture

Software.Land-derived realistic integration test data. It is not default package policy.

See `NOTICE.md` in this directory: Software.Land editorial/body content is not
licensed under the project license merely because it lives in this repository.

This directory is a snapshot of live V2 search inputs from the Software.Land
application. It exists so `@software-land/search` can exercise production-derived
ranking in this OSS repo without importing Gatsby, UI, or the Software.Land E2E
runner.

Lemmas, configured-concept rows, the relationship map, document relationships,
and lexical frequency here are **fixture arguments only**. They must be passed
into the engine by the test. There is no public root `english()` or
`dictionary()` helper. They must never become Core defaults.

Historical `expectedTop` / `titlePrefix` / `topN` rows are executable
Software.Land relevance contracts. They are not Core ranking policy and they
are not the exact-output oracle.

## Provenance

| Field | Value |
| --- | --- |
| Fixture format | `software-land-search-fixture` v1 (`manifest.json`) |
| Corpus source commit | `372ae05540036fea5671726f6ae43f5a75d9441d` |
| Previous corpus freeze | `971012bf3d561a67ca8a20f03ec2128135d1fb87` (before that, `dff24cf606967cb50b24d28d9142747c9203e053`) |
| Committed `content/blog` tree | `b4d56a987e86e28f6b69acb111596ce5d1ec911d` |
| Uncommitted inputs | yes. HEAD alone does not contain this corpus. `uncommittedDiffAlgorithm` is `git-diff-text-v1`: SHA-256 of `git diff HEAD` text. That digest is `4e1af47321ccfb08d549a80bd41c671f14695047ee48d4592218ac459a668719`. It is not a `worktree-bytes-v1` fingerprint. |
| `@software-land/search` | `0.7.0`, declared as `file:vendor/software-land-search-0.7.0.tgz` |
| Documents | 122 |
| Configured concepts | 191 (runtime acronym map merged with compiled extras; `testing` is not in this snapshot) |
| Lemmas | 1207, including the authored override `computing` → `compute` |

The committed blog tree at that SHA still contains both removed posts. The
export used the working tree: those posts deleted, their menu entries removed,
and inbound links revised. `export-content`, the site lemma build, and
`scripts/search-artifacts/compile.mjs` ran against that working tree. The
committed tree hash is recorded separately and is not the exported corpus.
Documents are the runtime shape: `id`, `title`, `summary` (frontmatter
description), and `body` from `normalizeSearchBody`. Configured concepts are
`mergeConfiguredConcepts(acronymMap, compiled extras)`. Lemmas are
`site-lemmas.json` after authored lemma policy. Lexical frequency and
`relationships.json` are the compiled runtime artifacts. `relationship-map.json`
is `relationshipMap.js` plus the live search-equivalence composition used by
`compileSoftwareLandAuthoredRelevance`.

Suite engines in this package still declare a title and body schema. The
summary field is stored because the website indexes it, and lexical frequency
was compiled with that summary. These suites do not add summary to the schema:
doing so would change retrieval independently of the corpus refresh.

`document-overlays.json` is empty. Fenwick Tree is corpus document `cm` at
`/fenwick-tree/`. Overlay rows must not be concatenated onto the corpus when
that would reuse `cm`.

### Content inventory since `971012b`

Added, in the committed tree:

- `cm` `/fenwick-tree/` Fenwick Tree

Removed in the uncommitted working tree. These ids are not in the exported documents, lexical frequency, or document relationships:

- `I` `/cursor-pagination-previous-page/` Previous Page Token for Cursor Pagination
- `ag` `/testing-in-software-engineering/` Testing in Software Engineering

The historical root-route baseline still names both former paths. The generated
redirect manifest does not. `/cursor-pagination-previous-page/`,
`/blog/cursor-pagination-previous-page/`, `/testing-in-software-engineering/`,
and `/blog/testing-in-software-engineering/` are not published pages.

Indexed title or body changed:

- `9` `/software-engineer-vs-software-developer/` Software Engineer vs Software Developer
- `A` `/about/` About this Blog
- `bk` `/terms-of-service-and-privacy-policy/` Terms and Privacy Policy
- `bl` `/what-is-an-api/` What is an API?
- `bo` `/working-with-apis/` Working with APIs
- `bv` `/react-design-systems/` React Design Systems
- `cl` `/integrity/` title `Integrity Is Not Obedience` → `Integrity`

`content/blog/distributed-cloud/index.md` changed in the source commit and did
not change the normalized title or body. Glossary remains excluded by the
document loader.

Document relationships were recompiled with the calibrated semantic compiler.
The trusted 302-edge pair set did not match, so the new graph is used. Fenwick
Tree (`cm`) is linked with Minmax Tree (`X`) and Monotonic Stack (`cg`). The
previous semantic pairs Authorization Middleware (`D`) ↔ CloudFront Signed
Cookies (`ci`) and Minmax Tree (`X`) ↔ Maximum Flow Algorithm (`w`) are gone.
Every relationship endpoint is a document id in this snapshot.

### Retained historical inputs

These files were not regenerated from the current engine:

- Scenario source commit `e4507c54451814fcafb9598640bd2323faacefa5` (`tests/search-scenarios.js`, 224 product rows). The OSS historical mirror is 223 rows, excluding historical exclusion `integ`.
- Strict V2 contract supplement `0a8b33b7604b61e75e03a55b9c1e59d8571a3e19`. Do not mine historical scenarios from this commit.
- `synonym-map.json` remains the `db5a070dbc6ac112dfae403f38fdfd0fffbedbf6` provenance snapshot (`relevanceSoftwareLandCommit`). It is not the composed relationship map.
- Historical contract updates `3ad49e867f82db06aa06cd1c7f38dca8faecf246`.
- Accepted `what are apis` regression from `62c51bad060fea9627f06c752341ea7434f86e46`.
- AppSec topical recall still matches `eac7a90a15d772f0f0626a0fa9481eb9efa55521`.
- NIST institute aliases now also live in the runtime acronym map. The earlier pin was `7628a85166781d4ab42f60646e2f66da5f336eaa` via `relevance-config.json`.
- The previous configured-concept overlay `dictionaryAcronymMapSoftwareLandCommit` (`df852eb4136dc5fb5b23cbf0bc22d45170e71423`) is not this snapshot. This refresh replaces that partial acronym overlay with the runtime merge.
- `query-result-oracle.json` remains the 215-query freeze (123 documents, head recorded in that file). It is not an identity gate for this 122-document corpus. It was not regenerated.
- `testing` and `quality ass` historical rows no longer name Testing in Software Engineering. That title was removed with the article. Load vs Stress Testing stays at its existing topN bound. No replacement title was taken from engine output. The historical top-N hash is `4a195cd6149c4fc680ad855ec59d94170b9397931ebfd378b67530e974cbb7de`.

The `integ` regression still requires document `cl` at rank 1. The expected title is the renamed post, `Integrity`, which is what `tests/search-scenarios.js` at the corpus commit requires. Rank and id are unchanged.

Fenwick Tree prefix contracts remain, now against corpus id `cm` rather than a synthetic overlay document. They still require Fenwick Tree inside the top 10. Rank 1 is not required.

## Files

- `documents.json` — `id`, `title`, `summary`, normalized search `body`
- `configured-concepts.json` — runtime `{ key, aliases }` merge. Aliases are unordered peers.
- `lemmas.json` — site lemma table passed to `morphology({ lemmas })`
- `relationships.json` — compiled document relationship graph (semantic plus domain editorial)
- `lexical-frequency.json` — production lexical-frequency artifact, compiled with title, summary, and normalized body
- `relationship-map.json` — authored map plus composed live equivalences
- `v2-contracts.json` — strict cases plus Fenwick corpus contracts in `overlayCases` (no `documentOverlay`)
- `document-overlays.json` — empty. Do not add an id that already exists in `documents.json`.
- `regression-scenarios.json` — B-intent compatibility coverage, not Core ranking policy
- `historical-scenarios.json` — retained 223-row historical mirror
- `historical-contract-updates.json` — retained product updates
- `relevance-config.json` — historical engine input selector (omit `testing`, NIST and AppSec patches, relationship map)
- `synonym-map.json` — retained `db5a070` provenance snapshot
- `query-result-oracle.json` — retained 215-query freeze for the previous corpus
- `scenarios.json` — retained scenario index
- `manifest.json` — format, provenance, counts, and SHA256s

Do not generate `expectedTop`, `topN`, `titlePrefix`, or oracle rows from current engine output.
