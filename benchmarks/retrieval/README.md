# Retrieval-mode benchmarks (development)

Candidate count **C** and search-side latency for `full-scan` / `indexed` / `adaptive` as corpus size **N** grows. **Not packed.** Not a search-quality claim. Not a CI latency gate.

Requires a built runtime (`npm run build`).

```bash
node benchmarks/retrieval/run.mjs
node benchmarks/retrieval/run.mjs --n 1000,5000
node benchmarks/retrieval/run.mjs --n 25000 --skip-full-scan
```

The mixed generator plants rare exact titles, version/dotted-span documents, a configured-equivalence entry, morphology lemmas, and a two-node relationship, then fills the rest with settings-like and article-like documents (overlapping vocabulary, not a toy exclusive to indexed retrieval).

Full-scan at N=25k is an explicit reference only. Do not describe it as scalable. Default `full-scan-max-n` is 5000; pass `--n 25000` without `--skip-full-scan` only when you intend to wait.

Indexed ordinary hits remain budgeted at `candidateLimit` (200). Exact-title, configured-equivalence, and version must-keeps stay unbounded. Contextual title-prefix and full-query title-prefix are capped at `prefixCap`.
