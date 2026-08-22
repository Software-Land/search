# Ranking envelope (development)

Latency at a **fixed candidate count C**. Builtin ranking groups candidates by constraint signature (B distinct signatures) and compares signatures instead of every candidate pair. Custom constraint functions still use the all-pairs path. The frozen oracle in `test/oracles/rankOracle.ts` is the behavioral truth for equivalence tests.

These files are **not** packed in the npm tarball (`package.json` `files` omits `benchmarks/`).

Requires a built runtime (`npm run build && npm run build:oracles`). Public `SearchEngine` plus internal `dist/rank.js` and test-only `test/oracles-dist/rankOracle.js` for old-vs-new rank-only timing.

```bash
node benchmarks/ranking/run.mjs
node benchmarks/ranking/run.mjs --c 100,200,500,1000
node benchmarks/ranking/run.mjs --workload homogeneous,few-buckets,mixed
node benchmarks/ranking/run.mjs --software-land
node benchmarks/ranking/run.mjs --c 200 --json
```

The homogeneous harness indexes C documents that all match one rare token, then searches with `retriever: "full-scan"` and `relationshipStrategy: "none"` so retrieval C equals C. That isolates ranker cost. It is not a claim that production retrieval should hand the ranker the whole corpus.

Workloads:

- **homogeneous** — B = 1, zero constraint edges (all-incomparable)
- **few-buckets** — a small exact-title set dominates the rest; the ranker must not materialize A×B candidate edges
- **mixed** — several title/version/literal/coverage classes
- **software-land** — representative queries on the real-corpus fixture (`--software-land`)

`newMs` / `oldMs` are median rank-only times for the production ranker vs the frozen all-pairs oracle on the same featured hits. `rankMs` is `searchDetailed` instrumentation (includes production ranking only). Common-case complexity is O(C log C + B²F + E_b), not a worst-case subquadratic guarantee: B = C remains possible.

Do not alter `candidateLimit` to make this look better. Do not cite Article 25k full-scan as scalable; that remains a demonstration of the algorithmic limit when C grows with a high-DF term.

Indexed / adaptive retrieval is how corpus size N is supposed to stay off the ranker. Exact-title, configured-equivalence, and version must-keep, plus relationship expansion, can still grow C independently of `candidateLimit`. See [docs/retrievers.md](../../docs/retrievers.md).
