# Retrieval-mode benchmarks (development)

Candidate count **C** and search-side latency for `full-scan` / exact `indexed` / `adaptive` as corpus size **N** grows. **Not packed.** Not a CI latency gate.

Requires a built runtime (`npm run build`).

```bash
node benchmarks/retrieval/run.mjs
node benchmarks/retrieval/run.mjs --n 1000,5000
node benchmarks/retrieval/run.mjs --n 25000 --skip-full-scan
```

The mixed generator plants rare exact titles, version/dotted-span documents, a configured-equivalence entry, morphology lemmas, and a two-node relationship, then fills the rest with settings-like and article-like documents (overlapping vocabulary, not a toy exclusive to indexed retrieval).

Full-scan at N=25k is an explicit reference only. Do not describe it as scalable. Default `full-scan-max-n` is 5000; pass `--n 25000` without `--skip-full-scan` only when you intend to wait.

Exact indexed retrieval enumerates all legitimate posting matches, reconstructs the frozen current features, and reduces final ranker input with exact per-signature representatives. `candidateLimit` remains accepted for compatibility but does not truncate this path. Stage 1 deliberately performs no posting/block pruning.

The permanent pressure harness also covers quality, artifact size, build/load cost, and posting instrumentation:

```bash
node scripts/budget-pressure.mjs --suite mixed --sizes 500,1000,2000,5000,10000,25000
node scripts/budget-pressure.mjs --suite software-land --floods 400,1000,5000
node --expose-gc scripts/budget-pressure.mjs --suite stage1 --sizes 1000,5000,10000,25000
```

The `stage1` report includes posting entries visited, distinct documents examined, raw-document scans, signatures, retained candidates, retrieve/feature/select/rank timing, deterministic artifact bytes, compile/load time, and process memory snapshots. It also serializes comparable architecture projections for (A) TF postings only, (B) TF postings plus explicit document token-id streams, and (C) the implemented unified positional analyzed index. A/B byte projections are not claims that unimplemented browser loaders have measured heap or latency. Timing and RSS are observational, not absolute CI thresholds.

Packed Chromium page-plus-Worker memory is opt-in because Chromium's experimental measurement API can take tens of seconds:

```bash
SEARCH_RETRIEVAL_SIZES=5000 SEARCH_MEASURE_BROWSER_MEMORY=1 \
  node test/chromium-pack/runner.mjs
```

The runner prefers an installed full Chrome when available and otherwise keeps memory values nullable. Default packed validation does not wait for memory measurements.
