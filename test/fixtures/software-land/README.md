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

This snapshot has 123 documents, 192 configured concepts, and 1240 lemmas, including the authored override `computing` → `compute`. The corpus was exported from Software.Land HEAD `2f085e6789d30dc7bdfa26027e0e9ab15d489f85`. The committed `content/blog` tree is `755fc9ba1edee11c9fe2bc56e866715297222443`. Article markdown in that tree is the document source. `manifest.json` records this dirty worktree with `worktree-bytes-v1` digest `a917a2f0cf180e4f5b6876fdda415222026091fdc4a12df31c3c408e151b40c3`. Uncommitted inputs on that HEAD are `__tests__/search-scenario-contract.test.js`, `__tests__/v2-against-v1-historical-topn-contract.test.js`, `docs/search-historical-contract-updates.json`, `docs/search-historical-contract-updates.md`, `scripts/search-artifacts/software-land-scenarios.mjs`, `tests/search-e2e-result-helpers.test.js`, `tests/search-e2e.js`, `tests/search-scenarios.js`, and `tests/search-v2-contracts.js`. The site dependency is `file:vendor/software-land-search-0.8.0.tgz`.

Earlier corpus pins remain provenance, not this snapshot: `372ae05540036fea5671726f6ae43f5a75d9441d`, `971012bf3d561a67ca8a20f03ec2128135d1fb87`, and `dff24cf606967cb50b24d28d9142747c9203e053`. The earlier committed blog tree was `b4d56a987e86e28f6b69acb111596ce5d1ec911d`. The previous corpus HEAD was `acf8fbf24bf417af6639838f07ec2246d35c0ed9`, kept on the manifest as `previousCorpusSourceCommit`. Its worktree digest was `d8517388cc4864cf8a8bc311fa89402abb8bec76949af52fa803d820b62821d0`, not the current manifest digest.

Documents use `id`, `title`, `summary`, and normalized search `body`. Bodies come from the site search-store pipeline: bracket-boundary link extraction, URL stripping, store tokenization, then `normalizeSearchBody`. Rendered navigation and footer text are not copied. Configured concepts are the runtime merge of `src/search/acronymMap.js` and the existing compiled extras. Lemmas are the existing site lemma artifact plus the authored `computing` → `compute` override. Lexical frequency was recompiled locally from those documents and lemmas. `relationships.json` is the existing compiled document graph, with no new embedding request. `relationship-map.json` is `relationshipMap.js` plus composed live equivalences. That map includes `api` → `interface` with `primaryTerm`, `dfs` → `tree`, and `ai` → `embeddings`. The `dfs` → `tree` edge is a later fixture correction. It replaces the snapshot’s authored `dfs` → `minimax` edge and does not change the corpus commit, content tree, or worktree digest recorded below.

Suite engines in this package declare a title and body schema. The summary field is stored with the documents, and lexical frequency includes that summary. These suites do not add summary to the schema.

Fenwick Tree is corpus document `cm` at `/blog/fenwick-tree/` and appears once.

### Content inventory for this refresh

Added:

- `cn` `/blog/llm-model-conversion-correctness/` LLM Model Conversion Correctness

Removed: none. These earlier ids stay absent:

- `I` `/cursor-pagination-previous-page/` Previous Page Token for Cursor Pagination
- `ag` `/testing-in-software-engineering/` Testing in Software Engineering

Normalized body changed:

- `9` `/blog/software-engineer-vs-software-developer/` Software Engineer vs Software Developer
- `A` `/blog/about/` About this Blog
- `bc` `/blog/what-is-recursion/` What is Recursion?
- `bw` `/blog/react-performance-optimization/` React Performance Optimization
- `cd` `/blog/topological-sort/` Topological Sort
- `cg` `/blog/monotonic-stack/` Monotonic Stack
- `ch` `/blog/working-with-llama-cpp-embeddings/` Working with Llama.cpp Embeddings
- `ck` `/blog/200-fps-css-vs-canvas-vs-webgl-vs-webgpu/` 200FPS: CSS vs Canvas vs WebGL vs WebGPU
- `cm` `/blog/fenwick-tree/` Fenwick Tree

Glossary is not in this snapshot. Compiled document relationships pair Fenwick Tree (`cm`) with Monotonic Stack (`cg`) and InOrder vs PreOrder vs PostOrder (`t`). Authorization Middleware (`D`) is paired with CloudFront Signed Cookies (`ci`). Minmax Tree (`X`) has no compiled document-relationship edge. Its DFS connection is the authored related form `tree`, which matches the title token. There is no authored `dfs` → `minimax` edge. LLM Model Conversion Correctness (`cn`) is paired with Working with Llama.cpp Embeddings (`ch`). Every relationship endpoint is a document id in this snapshot.

### Scenarios and retained inputs

The current source has 216 scenario rows. The historical mirror is 215 rows, excluding overlay-owned `integ`. Eight short NIST prefix rows left that source and are not in this mirror: `national`, `national i`, `national in`, `national institute`, `national institute o`, `national institute of`, `national institute o s`, and `national institute of s`. The longer NIST phrases remain. Enforced historical rows: 214. The historical top-N hash is `59561f315e944172ab83852f3762be29b00bfa4b96a6163c781f1a0f4d309632`.

These identities stay explicit and were not rewritten from engine output:

- Earlier scenario source commit `e4507c54451814fcafb9598640bd2323faacefa5` (224 source rows at that pin).
- Strict V2 contract supplement `0a8b33b7604b61e75e03a55b9c1e59d8571a3e19`.
- `synonym-map.json` remains the `db5a070dbc6ac112dfae403f38fdfd0fffbedbf6` provenance snapshot. It is not the composed relationship map.
- Historical contract updates pin `3ad49e867f82db06aa06cd1c7f38dca8faecf246`.
- Accepted `what are apis` regression from `62c51bad060fea9627f06c752341ea7434f86e46`.
- AppSec topical recall was introduced at `eac7a90a15d772f0f0626a0fa9481eb9efa55521`. The current map adds an ordinary related form `security`. That form is not an AppSec alias, not an equivalence, and not `primaryTerm`.
- **NIST:** the refreshed concept file already includes `institute of standards`. `relevance-config.json` adds that alias again and the loader dedupes it. It does not add the one-token `institute` alias. Previous fixture pin: `7628a85166781d4ab42f60646e2f66da5f336eaa`.
- The previous configured-concept overlay `dictionaryAcronymMapSoftwareLandCommit` (`df852eb4136dc5fb5b23cbf0bc22d45170e71423`) is not this snapshot.
- `query-result-oracle.json` remains the 215-query exact-output freeze. Its query list matches this historical mirror. It was not regenerated.
- Package-only overlays that remain are `strict-contracts.json` `overlayCases` and `regression-scenarios.json` `overlayCases`.

`appsec`, `app sec`, `application security`, `application se`, and `aplicationsecurity` keep App Sec first. RBAC and Authorization Middleware stay inside the visible ten. Zero-Trust Security is required inside the top 3 and precedes Working with Llama.cpp Embeddings when that article is also visible. Fourth place fails that window even though the article remains visible. `dfs` and `depth first search` keep Minmax Tree inside the visible ten through the corrected related form `tree`. That is not an authored `dfs` → `minimax` edge. The `sharde` A-class intent keeps Throughput vs Latency inside the visible ten. Linear vs Logistic Regression stays in the machine-learn historical membership bag and in the `machine learn`, `machine learni`, and `machine learnin` visible-ten contracts. `maachine leaarning` and `what is machine learning` require Linear vs Logistic Regression within the visible ten, not first; their other historical membership titles stay. DevOps rows do not require Agile vs Waterfall or What is Cloud Migration?. The six API phrase rows include Class vs Interface because the source authors the API primary-term edge. `what is an appli` keeps What is an API?, REST API vs GraphQL, and Working with APIs in the top five, and requires gRPC vs REST within ten.

Typing-session labels and the `recent search transitions` label are browser-only. They are not searched as queries and are not executable coverage. Bare keystrokes and clear are browser input behavior. Per-step queries that carry result assertions are executable when an existing case or overlay does not already cover them. Result hrefs are inventoried as browser path checks. `what is an appli` is not mined into regressions: its recorded B intent still requires What is an API? first, and that omission is package-only. The historical membership contract above is the source contract.

The `integ` regression still requires document `cl` at rank 1. The expected title is `Integrity`.

Fenwick Tree prefix contracts require corpus id `cm` within the top 10. Rank 1 is not required.

## Files

- `documents.json` — `id`, `title`, `summary`, normalized search `body`
- `configured-concepts.json` — runtime `{ key, aliases }` merge. Aliases are unordered peers.
- `lemmas.json` — lemma table passed to `morphology({ lemmas })`
- `relationships.json` — compiled document relationship graph reused from the site artifact cache
- `lexical-frequency.json` — lexical-frequency artifact, compiled locally from title, summary, and normalized body
- `relationship-map.json` — authored map plus composed equivalences, including the API primary-term edge, DFS → tree, AI/embeddings, and the ordinary AppSec → security edge. The DFS edge is the later fixture correction, not part of the original corpus snapshot.
- `strict-contracts.json` — strict cases plus Fenwick corpus contracts in `overlayCases`
- `regression-scenarios.json` — B-intent compatibility coverage, not Core ranking policy
- `historical-scenarios.json` — 215-row historical mirror of the current source
- `v1-historical-topn-contract.json` — hashed executable historical membership contract
- `historical-contract-updates.json` — product-decision record aligned to the current source contracts
- `relevance-config.json` — historical engine input selector (omit `testing`, NIST and AppSec patches, relationship map)
- `manifest.json` — corpus HEAD, content tree, worktree fingerprint, and fixture file hashes
- `nist-typing-progression.json` — institute-of typing steps for the packed Chromium corpus. Target is frozen document `ai`
- `synonym-map.json` — retained `db5a070` provenance snapshot
- `query-result-oracle.json` — retained 215-query exact-output freeze
- `scenarios.json` — scenario index for this source snapshot

Do not generate `expectedTop`, `topN`, `titlePrefix`, `within`, or oracle rows from current engine output.
