# Scaling

This page describes **current package behavior**, then historical shipped measurements, then unshipped research. Absolute milliseconds are machine-specific and are **not an SLA**.

## Current production capability

`@software-land/search` is exact in-memory indexed search. The fused ranking-evidence path shipped in 0.6.5. Eligible ordinary `SearchEngine.search()` / `searchAsync()` fuse exact ranking evidence into compiled retrieval, finalize it into packed numeric columns, and run the existing builtin selection / constraint ranking / default hybrid relationship path. Public results, ranking semantics, artifact format, and Worker protocol are unchanged.

Direct candidate-wide `FeatureVector` construction is eliminated on that eligible ordinary path. Default hybrid uses the optimized path. Unsupported shapes fail closed to the exact FeatureVector execution path. That fallback is success: same public results, not a quality degradation.

`searchDetailed()`, `explain: true`, exhaustive diagnostics, and complete-interpretation collection may still use the FeatureVector path.

0.6.5 is the last planned constant-factor v1 performance release for now. Production measurements cover 25k / 50k / 100k documents on one mixed workload. Ordinary million-document search under 50 ms is **not** current capability.

## 0.6.5 measured search() performance

Fresh same-machine comparison of untouched `@software-land/search` **v0.6.4** (`e9e1618`, tag `v0.6.4`) versus this 0.6.5 candidate. These are public `SearchEngine.search()` measurements, not older retrieve+features phase timings.

**Provenance.** Node v22.22.1, 2026-09-03. Machine: Linux x86_64, 13th Gen Intel Core i9-13900K (32 threads). Default `relationshipStrategy: "hybrid"`. Limit 10. Deterministic mixed generator, seed `0x60d6e7ed`. Warmup 6, iterations 24, interleaved baseline/candidate per query. Statistic p50/p95.

```text
node scripts/prod-search-bench.mjs \
  --baseline /path/to/v0.6.4 \
  --candidate /path/to/0.6.5 \
  --sizes 25000,50000,100000 \
  --iterations 24 --warmup 6
```

The script lives in the git tree under `scripts/` and is **not shipped in the npm tarball**. Result identity (ids, order, six-decimal score, `directClass`, `relevanceKind`, relationship payload) matched on every measured row. Eligible ordinary non-explain `search()` constructed **0** direct FeatureVectors on these queries. Lexical artifact format did not change.

Headline speedups on this suite:

| corpus | geometric p50 | aggregate p50 |
| --- | ---: | ---: |
| 25k | ~1.84× | ~2.09× |
| 50k | ~1.92× | ~2.11× |
| 100k | ~1.89× | ~2.08× |

Six ordinary non-tiny queries (`network`, `search index`, `searching`, `searc`, `serach`, `tls`) are about **2.2–2.3×** overall. Individual ordinary rows reach about **2.9×**. Not every query is 2× faster. `network` is about **1.37–1.45×**. `tls` is about **1.9×**. Tiny `integ` stays exact (Integrity document #1) and sub-millisecond; packed plan/session setup can add ~0.1–0.2 ms there. That is setup overhead, not a ranking regression.

Do not substitute older Stage 3A phase numbers, or an internal ~3.1× retrieve+features comparison, for these public API measurements.

### 25k documents

| query | eligible | candidates | identity | v0.6.4 p50 | 0.6.5 p50 | p50× | v0.6.4 p95 | 0.6.5 p95 | FeatureVectors 0.6.5 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| network | packed | 8652 | exact | 51.5 ms | 37.6 ms | 1.37 | 55.0 ms | 40.9 ms | 0 |
| search index | packed | 4650 | exact | 125.0 ms | 56.8 ms | 2.20 | 130.4 ms | 59.1 ms | 0 |
| searching | packed | 5720 | exact | 84.5 ms | 29.0 ms | 2.91 | 132.2 ms | 31.6 ms | 0 |
| searc | packed | 5720 | exact | 87.0 ms | 30.7 ms | 2.84 | 90.3 ms | 31.4 ms | 0 |
| serach | packed | 5720 | exact | 96.5 ms | 33.9 ms | 2.84 | 111.1 ms | 42.2 ms | 0 |
| tls | packed | 4235 | exact | 185.5 ms | 96.4 ms | 1.92 | 197.8 ms | 106.8 ms | 0 |
| integ | packed | 1 | exact | 0.18 ms | 0.34 ms | 0.53 | 0.23 ms | 0.38 ms | 0 |

Geometric mean p50 **1.84×**. Aggregate mean p50 **2.09×**.

### 50k documents

| query | eligible | candidates | identity | v0.6.4 p50 | 0.6.5 p50 | p50× | v0.6.4 p95 | 0.6.5 p95 | FeatureVectors 0.6.5 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| network | packed | 17272 | exact | 130.4 ms | 91.0 ms | 1.43 | 151.0 ms | 102.4 ms | 0 |
| search index | packed | 9385 | exact | 285.5 ms | 127.5 ms | 2.24 | 309.8 ms | 135.8 ms | 0 |
| searching | packed | 11439 | exact | 194.7 ms | 66.3 ms | 2.94 | 199.2 ms | 72.2 ms | 0 |
| searc | packed | 11439 | exact | 195.9 ms | 69.9 ms | 2.80 | 207.7 ms | 72.7 ms | 0 |
| serach | packed | 11439 | exact | 213.7 ms | 77.4 ms | 2.76 | 242.8 ms | 85.1 ms | 0 |
| tls | packed | 8457 | exact | 367.9 ms | 190.1 ms | 1.94 | 389.0 ms | 206.0 ms | 0 |
| integ | packed | 1 | exact | 0.16 ms | 0.23 ms | 0.69 | 0.20 ms | 0.25 ms | 0 |

Geometric mean p50 **1.92×**. Aggregate mean p50 **2.11×**.

### 100k documents

| query | eligible | candidates | identity | v0.6.4 p50 | 0.6.5 p50 | p50× | v0.6.4 p95 | 0.6.5 p95 | FeatureVectors 0.6.5 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| network | packed | 34555 | exact | 271.1 ms | 186.9 ms | 1.45 | 294.2 ms | 195.3 ms | 0 |
| search index | packed | 18773 | exact | 611.8 ms | 274.4 ms | 2.23 | 635.4 ms | 283.7 ms | 0 |
| searching | packed | 22957 | exact | 422.9 ms | 147.9 ms | 2.86 | 463.8 ms | 163.4 ms | 0 |
| searc | packed | 22957 | exact | 423.7 ms | 156.9 ms | 2.70 | 441.0 ms | 170.4 ms | 0 |
| serach | packed | 22957 | exact | 433.2 ms | 159.8 ms | 2.71 | 450.1 ms | 173.7 ms | 0 |
| tls | packed | 16845 | exact | 777.0 ms | 400.6 ms | 1.94 | 792.4 ms | 409.4 ms | 0 |
| integ | packed | 1 | exact | 0.13 ms | 0.20 ms | 0.65 | 0.16 ms | 0.23 ms | 0 |

Geometric mean p50 **1.89×**. Aggregate mean p50 **2.08×**.

Internal packed-state accounting reported about **4.4 MB** at 25k, **8.9 MB** at 50k, and **17.8 MB** at 100k. This accounting covers the pool's tracked typed-array/static storage plus one retained idle session; it does not include JavaScript `Map` / `Set` / array/object overhead and should not be read as total incremental process memory. The lexical artifact format is unchanged.

## What still scales with query/corpus size

Larger N does not switch into a lower-quality retrieval mode. Exact compiled retrieval keeps exact per-signature representatives. Ranking stays exact rather than approximate.

As N and workload grow, remaining costs include:

- query-time posting work on competitive / conjunction classes
- prefix expansion (still exhaustive per matching term)
- ranking-evidence / feature work on documents that are still evaluated
- artifact / load cost
- browser / process memory

Workload depends more on query document frequency, posting entries touched, prefix expansion, the number and distribution of **competitive** matches, and relationship behavior than on N alone. A 100k corpus with a rare exact title can be cheap. A 5k corpus with a high-DF prefix and active relationships can be expensive.

Stage 3A still skips unread noncompetitive 1-of-k body postings after stronger co-occurrence classes are evaluated. 0.6.5 packed ranking evidence removes candidate-wide FeatureVector construction on the eligible ordinary lane. Neither makes high-DF conjunction work flat with N.

## Practical demonstrated range

Indexed exact search has been **validated through about 100k documents** on the mixed generator above and on the older Stage 3A VPN-like tables below. Roughly **50k–100k** is the currently demonstrated practical corpus range, subject to query distribution, environment, artifact size, and latency requirements.

That range is an engineering/performance observation. It is not a correctness limit, a quality cliff, a hard corpus maximum, or an SLA. Do not read the tables as “100k always searches in X ms.”

## Current exact pruning / fused evidence architecture

Two layers, not one:

1. **Retrieval pruning** (shipped since 0.6.x Stage 2A / 2B / 3A) — skip work that cannot change exact representatives. Stage 3A may skip unread 1-of-k body postings. See [exact-pruning.md](exact-pruning.md).
2. **Ranking-evidence production** (0.6.5) — on eligible ordinary `search()` / `searchAsync()`, the same compiled posting/mask walk already required by retrieval also records exact ranking evidence. After numeric finalization, packed direct views feed the existing builtin selector and constraint ranker. There is no second high-DF posting traversal.

Eligible ordinary path:

```text
analyze → query plan
  → compiled retrieval + fused exact ranking evidence
  → exact numeric finalization / packed direct views
  → existing builtin selection / constraint ranking
  → existing default hybrid relationship semantics
  → public results
```

Diagnostic / fallback path (`searchDetailed()`, explain, exhaustive diagnostics, unsupported shapes, custom retrievers):

```text
retrieve
  → FeatureVector extraction
  → existing selection / ranking / hybrid
  → public results
```

There is no public optimization toggle and no artifact extension for ranking evidence. Missing or ineligible cases fail closed to the FeatureVector path. Stage 3A is exact signature-aware block skipping, not classic WAND, BMW, or MaxScore.

Conceptual ineligibility (not a quality loss): recall-heavy equivalent/topical/standalone queries, dotted/version queries, bound contextual completion, short-literal leads, custom retrieval/ranking, nonzero retrieval-score weight, `all-strong`, and diagnostic/explain/complete-interpretation surfaces. Canonical Stage 3A fail-closed classes remain in [exact-pruning.md](exact-pruning.md).

## Historical Stage 3A measurements

These rows compare exhaustive compiled retrieval versus Stage 3A unread-block skipping on `"virtual private network"`. They are **0.6.1** provenance, not the 0.6.5 public `search()` comparison above. Do not treat them as current end-to-end speedup.

Deterministic mixed generator, seed `0x60d6e7ed`, 60-token articles. Same engine/artifact, exhaustive vs Stage 3A auto.

**Provenance.** `@software-land/search` **0.6.1**, git `d9aff6b` (tag `v0.6.1`), Node v22.22.1, 2026-08-31. Machine: Linux x86_64, 13th Gen Intel Core i9-13900K (32 threads). Warmup 2, iterations 7, statistic p50.

```text
node --expose-gc scripts/exact-block-skip-bench.mjs --sizes 25000,100000
```

That script lives in the git tree under `scripts/` and is **not shipped in the npm tarball**. Work counters, skip-block accounting, exactness, and artifact bytes match the original Stage 3A landing tables. Absolute p50 is higher than those earlier figures (~238.5 ms / ~46.3 ms at 25k; ~182 ms Stage 3A at 100k). Treat the millisecond delta as a **constant-factor latency refresh** of the same Θ(competitive/conjunction) path, not as a scaling-complexity regression.

### 25k documents

| | exhaustive | Stage 3A |
| --- | ---: | ---: |
| legitimate matches | 10,041 | 10,041 (materialized 1,954) |
| posting entries decoded | 59,294 | 4,279 |
| materialized documents | 10,041 | 1,954 |
| FeatureVectors | 10,041 | 1,954 |
| p50 | ~309.6 ms | ~59.9 ms |

Corrected Stage 3A body-presence block counters (unique 128-document ordinal blocks):

| counter | value |
| --- | ---: |
| `postingBlocksTotal` | 196 |
| `postingBlocksDecoded` | 1 |
| `postingBlocksClassifiedFromMasks` | 195 |
| `postingBlocksSkippedUnread` | 195 |

Invariant: `total = decoded + classifiedFromMasks`. `skippedUnread` is a subset of `classifiedFromMasks`.

Lexical artifact ~13.1 MB; v2 metadata ~964 KB (~7.4%).

### 100k documents

| | exhaustive | Stage 3A |
| --- | ---: | ---: |
| legitimate matches | 40,195 | 40,195 (materialized 7,792) |
| posting entries decoded | 237,434 | 17,117 |
| materialized documents | 40,195 | 7,792 |
| FeatureVectors | 40,195 | 7,792 |
| p50 | ~1259 ms | ~250.9 ms |

Stage 3A body-presence block counters at 100k: `postingBlocksTotal` 782, `decoded` 1, `classifiedFromMasks` 781, `skippedUnread` 781 (same invariant as 25k).

Lexical artifact ~54.0 MB; v2 metadata ~3.89 MB (~7.2%). Output stayed exact vs exhaustive.

A later rerun of the same command on the same host showed absolute-latency variation while reproducing identical work counters, artifact sizes, and exactness. The documented table retains the explicitly captured 0.6.1 measurement series.

25k → 100k: corpus size ≈ 4×, remaining competitive/conjunction work ≈ 4× (matches 10,041 → 40,195; materialized 1,954 → 7,792; posting entries 4,279 → 17,117). Stage 3A eliminated the large 1-of-k body flood before decode and materialization. It did **not** make this VPN workload flat with N.

## Million-document research findings

The following numbers are **unshipped investigation**, not 0.6.5 production behavior and not a package benchmark. They exist so readers do not confuse research prototypes with the current runtime.

On a true 1,000,000-document mixed corpus:

- ordinary high-DF queries on the previous exact compiled architecture measured about **2.81–5.33 s** p50
- packed research prototypes reduced that to about **0.5–1.0 s** p50 while preserving exactness
- a rare-title posting-local path measured about **42 ms** p50; that is a selective query, not ordinary high-DF work
- ordinary 1M search under **50 ms** was **not** achieved
- oracle / skip-bound research showed large theoretical skip opportunity on some classes
- the existing v1 posting/conjunction architecture still scales with high-DF work

Those prototypes are not shipped. They must not be read as 0.6.5 latency, as a public `compoundAcceleration` option, or as a new artifact format. 0.6.5 does not introduce compound-state acceleration.

## Artifact / memory considerations

At 100k the measured lexical artifact on the Stage 3A VPN-like workload was about **54 MB**. Naïve linear extrapolation of that density is a separate distribution/memory problem around million-document corpora. Treat that only as a density observation.

Scaling has two related but separate problems:

1. **query work** — how much index/candidate state a query touches
2. **artifact / storage / memory** — what must be downloaded, mapped, and retained

Solving one does not automatically solve the other. 0.6.5 ranking-evidence state is additional query-time memory (about 4.4 / 8.9 / 17.8 MB retained at 25k / 50k / 100k on the production benches above). Compact document views remain Stage 2C; see [compact-runtime.md](compact-runtime.md).

## Long-term scaling direction

0.6.5 is the last planned constant-factor v1 performance release for now. There is no committed next production slice of Stage 3A / WAND / block-mask / compound-state work.

Million-document ordinary low-latency search requires a more fundamental execution or index architecture than further constant-factor tuning of the current v1 path. A useful conceptual target is millions of indexed documents with ordinary queries touching only hundreds or thousands of competitive candidates. That complexity class is **not proven**. A ~50 ms ordinary-query figure at that scale is an **aspirational investigation benchmark**, not an SLA and not a claim that 0.6.5 achieves 1M / 50 ms (or 1M / 5 ms, O(1), or constant-time search).

Partitioning or multi-process/Worker distribution may eventually help storage, memory, topology, throughput, or fault isolation. Sharding a Θ(N) or Θ(matches) query path only divides that work; it does not by itself yield sublinear query complexity.

The production path remains a single compiled index. See [architecture.md](architecture.md), [limitations.md](limitations.md), [retrievers.md](retrievers.md), [compact-runtime.md](compact-runtime.md), and [exact-pruning.md](exact-pruning.md).
