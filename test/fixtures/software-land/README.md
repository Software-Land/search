# Software.Land search fixture

Software.Land fixtures under `test/fixtures/software-land/` provide a self-contained snapshot for integration tests. Their configuration and relevance expectations are fixture-specific and do not define the search engine’s defaults.

See `NOTICE.md` in this directory. Software.Land editorial and body content is not licensed under the project license merely because it lives in this repository.

Lemmas, configured concepts, the relationship map, document relationships, and lexical frequency are fixture arguments. Tests pass them into the engine. There is no public root `english()` or `dictionary()` helper.

Historical `expectedTop`, `titlePrefix`, and `topN` rows are relevance contracts for this fixture (`test/software-land-historical-relevance.test.js`). They are not Core ranking policy and they are not the exact-output oracle. `query-result-oracle.json` is the retained exact-output freeze for an earlier corpus.

After `npm run build`, run the fixture tests from this package:

```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js test/software-land-corpus.test.js
```

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

The committed blog tree at that SHA still contains both removed posts. The exported documents come from the working tree at the recorded source commit: those posts deleted, their menu entries removed, and inbound links revised. The committed tree hash is recorded separately and is not the exported corpus.

Documents use `id`, `title`, `summary`, and normalized search `body`. Configured concepts are the merged rows in `configured-concepts.json`. Lemmas are the mappings in `lemmas.json`, including `computing` → `compute`. Lexical frequency and `relationships.json` are the compiled artifacts stored here. `relationship-map.json` is the authored map plus composed equivalences for this snapshot.

Suite engines in this package declare a title and body schema. The summary field is stored with the documents, and lexical frequency includes that summary. These suites do not add summary to the schema: doing so would change retrieval independently of this snapshot.

`document-overlays.json` is empty. Fenwick Tree is corpus document `cm` at `/fenwick-tree/`. Overlay rows must not be concatenated onto the corpus when that would reuse `cm`.

### Content inventory since `971012b`

Added, in the committed tree:

- `cm` `/fenwick-tree/` Fenwick Tree

Removed in the uncommitted working tree. These ids are not in the exported documents, lexical frequency, or document relationships:

- `I` `/cursor-pagination-previous-page/` Previous Page Token for Cursor Pagination
- `ag` `/testing-in-software-engineering/` Testing in Software Engineering

The historical root-route baseline still names both former paths. Those paths are not documents in this snapshot:

- `/cursor-pagination-previous-page/`
- `/blog/cursor-pagination-previous-page/`
- `/testing-in-software-engineering/`
- `/blog/testing-in-software-engineering/`

Indexed title or body changed:

- `9` `/software-engineer-vs-software-developer/` Software Engineer vs Software Developer
- `A` `/about/` About this Blog
- `bk` `/terms-of-service-and-privacy-policy/` Terms and Privacy Policy
- `bl` `/what-is-an-api/` What is an API?
- `bo` `/working-with-apis/` Working with APIs
- `bv` `/react-design-systems/` React Design Systems
- `cl` `/integrity/` title `Integrity Is Not Obedience` → `Integrity`

`distributed-cloud` changed in the source commit and did not change the normalized title or body. Glossary is not in this snapshot.

Document relationships in this snapshot link Fenwick Tree (`cm`) with Minmax Tree (`X`) and Monotonic Stack (`cg`). Authorization Middleware (`D`) is not paired with CloudFront Signed Cookies (`ci`). Minmax Tree (`X`) is not paired with Maximum Flow Algorithm (`w`). Every relationship endpoint is a document id in this snapshot.

### Retained historical inputs

These files were not regenerated from the current engine:

- Scenario source commit `e4507c54451814fcafb9598640bd2323faacefa5` (224 source rows). The historical mirror in this directory is 223 rows, excluding `integ`.
- Strict V2 contract supplement `0a8b33b7604b61e75e03a55b9c1e59d8571a3e19`. Historical scenarios in this snapshot were not taken from that commit.
- `synonym-map.json` remains the `db5a070dbc6ac112dfae403f38fdfd0fffbedbf6` provenance snapshot (`relevanceSoftwareLandCommit`). It is not the composed relationship map.
- Historical contract updates `3ad49e867f82db06aa06cd1c7f38dca8faecf246`.
- Accepted `what are apis` regression from `62c51bad060fea9627f06c752341ea7434f86e46`.
- AppSec topical recall still matches `eac7a90a15d772f0f0626a0fa9481eb9efa55521`.
- NIST aliases in this snapshot match the runtime acronym map: the full name, `institute standards`, and `nist`. The one-token `institute` alias is absent. The earlier pin was `7628a85166781d4ab42f60646e2f66da5f336eaa` via `relevance-config.json`.
- The previous configured-concept overlay `dictionaryAcronymMapSoftwareLandCommit` (`df852eb4136dc5fb5b23cbf0bc22d45170e71423`) is not this snapshot. This refresh replaces that partial acronym overlay with the runtime merge.
- `query-result-oracle.json` remains the 215-query freeze (123 documents, head recorded in that file). It is not an identity gate for this 122-document corpus. It was not regenerated.
- `testing` and `quality ass` historical rows no longer name Testing in Software Engineering. That title was removed with the article. Load vs Stress Testing stays at its existing topN bound. No replacement title was taken from engine output. The historical top-N hash is `526c745084124e0b9ee7e22347cc7c5d7d8cd91f8564e7487decde39e1344671`.

The `integ` regression still requires document `cl` at rank 1. The expected title is `Integrity`. Rank and id are unchanged.

Fenwick Tree prefix contracts remain, now against corpus id `cm` rather than a synthetic overlay document. They still require Fenwick Tree inside the top 10. Rank 1 is not required.

## Files

- `documents.json` — `id`, `title`, `summary`, normalized search `body`
- `configured-concepts.json` — runtime `{ key, aliases }` merge. Aliases are unordered peers.
- `lemmas.json` — lemma table passed to `morphology({ lemmas })`
- `relationships.json` — compiled document relationship graph (semantic plus domain editorial)
- `lexical-frequency.json` — lexical-frequency artifact, compiled with title, summary, and normalized body
- `relationship-map.json` — authored map plus composed equivalences
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
