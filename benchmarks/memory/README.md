# Memory benchmarks (development)

Process RSS / V8 heap measurements for `SearchEngine.index` and `search`. **Not packed** in the npm tarball (`package.json` `files` omits `benchmarks/`).

RSS is **process resident size**, not retained index size. Prefer `heapUsed` after `global.gc()` (`node --expose-gc`) for retained figures.

These generators are deterministic (seed `0x5e1ec7`). They are not search-quality benchmarks.

## Shapes

| Shape | What it models | Do not claim |
| --- | --- | --- |
| `settings` | Short titles + short overlapping help text | — |
| `article` | Longer bodies, **closed overlapping vocabulary** (~144 types), high document frequency | General prose / unique-token encyclopedia memory |
| `article-diverse` | Same skeleton with per-document unique tokens mixed in | Use this path when measuring intern/unique-string cost |

`article` exists because it reproduces full-scan high-DF candidate explosion. A 144-type workload is **not** a model of Wikipedia-like unique prose.

## Modes

Requires a built runtime (`npm run build`). Public `SearchEngine` + `morphology()` only.

```bash
node --expose-gc benchmarks/memory/run.mjs --mode routine
node --expose-gc benchmarks/memory/run.mjs --mode large
node --expose-gc benchmarks/memory/run.mjs --mode oom-probe
node --expose-gc --max-old-space-size=8192 benchmarks/memory/run.mjs --mode oom-probe
node --expose-gc benchmarks/memory/run.mjs --shape settings --n 10000 --query "bluetooth settings" --json
node --expose-gc benchmarks/memory/run.mjs --shape article-diverse --n 1000 --query tls
```

| Mode | Workload | When |
| --- | --- | --- |
| `routine` | settings 1k `wifi`; article 1k `virtual private` | Ordinary local reproduction |
| `large` | settings 10k `bluetooth settings` (~9k full-scan candidates) | Ranking-allocation / high-DF proof |
| `oom-probe` | article 25k `tls` | Pathological high-DF stress case. After 0.3.1 ranking-memory hardening it completes under the normal Node heap on the measured environment. `--max-old-space-size=8192` is optional headroom / historical comparison. Not a unit test. Not a claim that full-scan is fast or scalable. |

Each report distinguishes source-corpus heap, post-index heap before/after GC, source-drop retained heap, search pre-GC delta, search post-GC heap, and the full V8 accounting (`heapUsed`, `heapTotal`, `external`, `arrayBuffers`, RSS). Packed constraint edges live in `arrayBuffers` / `external`, not only `heapUsed`.

Pair-comparison count is `C*(C-1)/2` from that candidate count. Ranking comparison time remains Θ(C²) even when diagnostic objects are not retained.

## 0.3.1 scope

This tree measures the full-scan constraint-ranking allocation fix. It does not claim IndexedDocument/Set/posting compaction.
