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

Exact indexed retrieval enumerates all legitimate posting matches, reconstructs the frozen current features, and reduces final ranker input with exact per-signature representatives. `candidateLimit` remains accepted for compatibility but does not truncate this path. Stage 2A may reject full feature work for proven single-token body-only document blocks; it does not skip posting entries.

The permanent pressure harness also covers quality, artifact size, build/load cost, and posting instrumentation:

```bash
node scripts/budget-pressure.mjs --suite mixed --sizes 500,1000,2000,5000,10000,25000
node scripts/budget-pressure.mjs --suite software-land --floods 400,1000,5000
node --expose-gc scripts/budget-pressure.mjs --suite stage1 --sizes 1000,5000,10000,25000
node --expose-gc scripts/exact-pruning-bench.mjs --sizes 1000,5000,10000,25000
```

The `stage1` report includes posting entries visited, distinct documents examined, raw-document scans, signatures, retained candidates, retrieve/feature/select/rank timing, deterministic artifact bytes, compile/load time, and process memory snapshots. Timing uses warmup plus several same-run iterations and reports p50 (and p90 where present). Absolute milliseconds are observational and are not comparable across machines or days; a previous ~169 → ~126 ms Stage-1 sample is methodology/hardware noise, not a semantic regression. A/B byte projections are not claims that unimplemented browser loaders have measured heap or latency. Timing and RSS are not CI thresholds.

Compact-runtime heap and same-run latency:

```bash
node --expose-gc scripts/heap-attribution.mjs --n 25000
node --expose-gc scripts/compact-runtime-bench.mjs --sizes 1000,5000,10000,25000
```

See [compact-runtime.md](../../docs/compact-runtime.md).

The Stage-2A report runs exhaustive and pruned compiled modes on identical corpora and records exact output equality, posting visits/skips, document blocks, full feature evaluations, bound rejections, timings, artifact/load cost, and metadata bytes for 32/64/128/256-document layouts. The implemented layout is 128. Posting skips are expected to remain zero in Stage 2A.

Packed Chromium page-plus-Worker memory is opt-in because Chromium's experimental measurement API can take tens of seconds:

```bash
SEARCH_RETRIEVAL_SIZES=5000 SEARCH_MEASURE_BROWSER_MEMORY=1 \
  node test/chromium-pack/runner.mjs
```

The runner compares full scan, indexed fallback, precompiled exhaustive, and precompiled pruned Worker modes. It prefers an installed full Chrome when available and otherwise keeps memory values nullable. Default packed validation does not wait for memory measurements.
