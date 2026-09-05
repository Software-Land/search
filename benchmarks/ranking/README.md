# Ranking envelope (development)

Latency at a **fixed candidate count C**. Builtin ranking groups candidates by constraint signature (B distinct signatures) and compares signatures instead of every candidate pair. Custom constraint functions still use the all-pairs path. The frozen oracle in `test/oracles/rankOracle.ts` is the behavioral truth for equivalence tests.

These files are **not** packed in the npm tarball (`package.json` `files` omits `benchmarks/`).

Requires a built runtime (`npm run build && npm run build:oracles`). Public `SearchEngine` plus internal `dist/ranking/rank.js` and test-only `build/test/oracles/rankOracle.js` for old-vs-new rank-only timing. `test/oracles/*.ts` is the frozen oracle source; the JS emit is test-only and is not packed.

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

Exact indexed/adaptive retrieval keeps corpus size N off the final ranker by retaining sufficient per-signature representatives after exhaustive matching and relationship expansion. High-DF terms, many signatures, custom constraints, and deep relationship output can still grow C; `candidateLimit` is not an exact-path cap and there is no “must-keep versus budgeted rest” split. See [docs/retrievers.md](../../docs/retrievers.md).
