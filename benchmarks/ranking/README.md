# Ranking envelope (development)

Latency at a **fixed candidate count C**. Pairwise constraint ranking is Θ(C²) in C, not in corpus size N.

These files are **not** packed in the npm tarball (`package.json` `files` omits `benchmarks/`).

Requires a built runtime (`npm run build`). Public `SearchEngine` + `english()` only.

```bash
node benchmarks/ranking/run.mjs
node benchmarks/ranking/run.mjs --c 100,200,500,1000
node benchmarks/ranking/run.mjs --c 200 --json
```

The harness indexes C documents that all match one rare token, then searches with `retriever: "full-scan"` and `relationshipStrategy: "none"` so retrieval C equals C. That isolates ranker cost. It is not a claim that production retrieval should hand the ranker the whole corpus.

| C | Pair comparisons |
| --- | --- |
| 100 | 4,950 |
| 200 | 19,900 |
| 500 | 124,750 |
| 1000 | 499,500 |

Do not alter `candidateLimit` to make this look better. Do not cite Article 25k full-scan as scalable; that remains a demonstration of the algorithmic limit when C grows with a high-DF term.

Indexed / adaptive retrieval is how corpus size N is supposed to stay off the ranker. Exact-title, configured-equivalence, and version must-keep, plus relationship expansion, can still grow C independently of `candidateLimit`. See [docs/retrievers.md](../../docs/retrievers.md).
