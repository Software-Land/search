# Scaling

Indexed exact search has been **validated through about 100k documents** on a deterministic mixed VPN-like workload (see measurements below). Roughly **50k–100k** is the currently demonstrated practical corpus range for the indexed runtime, subject to query distribution, environment, artifact size, and latency requirements.

That range is an engineering/performance observation. It is not a correctness limit, a quality cliff, a hard corpus maximum, or an SLA.

Read this page as three different kinds of claim:

1. **Measured current capability** — the 25k/100k tables below, on the named machine and package. Absolute milliseconds are not an SLA.
2. **Architectural characterization** — what Stage 3A skips, what remaining work still scales with corpus size on that workload, which paths fail closed to exhaustive retrieval, and that ranking stays exact rather than approximate.
3. **Long-term goals** — million-document search, and a ~50 ms ordinary-query figure at that scale, are aspirational investigation targets. They are not a current capability, promise, or SLA, and they do not imply 1M / 5 ms, O(1), or constant-time search.

Stage 1 removed the old fixed-candidate quality failure. Larger N does not switch into a lower-quality retrieval mode. Exact compiled retrieval keeps exact per-signature representatives. Stage 2A may skip full feature work only for proven classes; it does not drop matches to stay under a budget. Stage 3A may skip unread noncompetitive 1-of-k body postings after stronger co-occurrence classes are evaluated; it does not approximate ranking.

As N and workload grow, the current limits are:

- query-time posting work on competitive / conjunction classes
- prefix expansion (still exhaustive per matching term)
- feature work on documents that are evaluated
- artifact/load cost
- browser memory

Workload depends more directly on query document frequency, posting entries touched, prefix expansion, the number and distribution of **competitive** matches, and relationship behavior than on N alone. A 100k corpus with a rare exact title can be cheap. A 5k corpus with a high-DF prefix and active relationships can be expensive.

## What Stage 3A changed

Before Stage 3A, exact indexed multi-token search followed:

```text
posting union
  → enumerate essentially every legitimate match
  → provenance scan
  → FeatureVector construction
  → representative pruning
```

Stage 3A keeps exact ranking semantics and uses shared document-ordinal block metadata:

```text
shared 128-document ordinal body-presence masks
  → determine exact co-occurrence classes
  → evaluate stronger classes first (k-of-k, then partial conjunction)
  → saturate exact per-signature representative streams
  → skip unread noncompetitive 1-of-k body postings
```

That is **exact signature-aware block skipping** (document-ordinal block pruning). It is not classic WAND, BMW, or MaxScore: ranking uses per-signature representative streams and partial-order constraints, not one global scalar top-K threshold.

Properties:

- results stay identical to exhaustive compiled `search()` on the supported path
- no approximate top-K
- omitted `exact-pruning-v2` fails closed to exhaustive retrieval; claimed malformed v2 rejects at load
- single-block body lists omit masks and reconstruct presence from the list while it still occupies one block
- `searchDetailed()` and other unsupported classes fail closed; the canonical list is in [exact-pruning.md](exact-pruning.md)
- skipped 1-of-k body postings are genuinely not decoded or materialized

Prefix expansion, classic WAND/BMW, and approximate top-K remain out of scope for Stage 3A. See [exact-pruning.md](exact-pruning.md).

## Stage 3A measured VPN-like workload

Deterministic mixed generator, seed `0x60d6e7ed`, 60-token articles, query `"virtual private network"`. Same engine/artifact, exhaustive vs Stage 3A auto. Absolute milliseconds and artifact bytes are one Node process on the acceptance machine, **not an SLA**.

**Provenance.** These rows are `@software-land/search` **0.6.1**, git `d9aff6b` (tag `v0.6.1`), Node v22.22.1, 2026-08-31. Machine: Ubuntu 26.04.1 LTS, Linux 7.0.0-30-generic x86_64, 13th Gen Intel Core i9-13900K (32 threads). Warmup 2, iterations 7, statistic p50. Absolute milliseconds are that Node process on that machine and are **not an SLA**.

```text
node --expose-gc scripts/exact-block-skip-bench.mjs --sizes 25000,100000
```

That is `scripts/exact-block-skip-bench.mjs` with its default warmup 2 and iterations 7. The script lives in the git tree under `scripts/` and is **not shipped in the npm tarball**; reproduce from a repository checkout, not from `node_modules/@software-land/search`. Work counters, skip-block accounting, exactness, and artifact bytes match the original Stage 3A landing tables. Absolute p50 is higher than those earlier figures (~238.5 ms / ~46.3 ms at 25k; ~182 ms Stage 3A at 100k). Treat the millisecond delta as a **constant-factor latency refresh** of the same Θ(competitive/conjunction) path, not as a scaling-complexity regression.

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

Do not read these rows as “100k always searches in X ms.” They are that generator, seed, query, package version, commit, and machine.

A later rerun of the same command on the same host showed absolute-latency variation while reproducing identical work counters, artifact sizes, and exactness. The documented table retains the explicitly captured 0.6.1 measurement series.

## Remaining linear bottleneck

25k → 100k: corpus size ≈ 4×, remaining competitive/conjunction work ≈ 4× (matches 10,041 → 40,195; materialized 1,954 → 7,792; posting entries 4,279 → 17,117).

Stage 3A eliminated the large 1-of-k body flood before decode and materialization. It did **not** make this VPN workload flat with N. Conjunction and partial-conjunction cardinality still scale approximately with corpus size on this query.

## Artifact / memory footprint

At 100k the measured lexical artifact was about **54 MB**. Naïve linear extrapolation of that density is a separate distribution/memory problem around million-document corpora. Treat that only as a density observation: future compression, bitmaps, or segmented/on-demand loading may change representation.

Scaling therefore has two related but separate problems:

1. **query work** — how much index/candidate state a query touches
2. **artifact / storage / memory** — what must be downloaded, mapped, and retained

Solving one does not automatically solve the other.

## Long-term complexity goal

For ordinary indexed queries, as corpus size N grows while the genuinely competitive evidence set remains small, query work should grow **substantially slower than N**, and ideally approach:

```text
metadata traversal
  + competitive posting regions
  + a small candidate set
```

rather than enumerating all matching documents.

A useful conceptual target is millions of indexed documents with ordinary queries touching only hundreds or thousands of competitive candidates. That complexity class is **not proven**. It is the direction, not a current capability.

The next scaling objective is to make ordinary query work sufficiently sublinear that million-document corpora become practical without relying on corpus-wide scans or simply distributing linear work. A ~50 ms ordinary-query figure at that scale is an **aspirational investigation benchmark**, not an SLA and not a claim that the current architecture achieves 1M / 50 ms (or 1M / 5 ms, O(1), or constant-time search).

## Roadmap

### Current: Stage 3A (shipped)

- inverted lexical index
- packed posting arrays (JavaScript `number[]` identity)
- shared 128-document ordinal blocks
- per-term body presence masks (`exact-pruning-v2`)
- exact signature-aware unread-block skipping
- skips much of the 1-of-k body flood
- validated through 100k on the VPN-like benchmark above

Also already shipped: Stage 1 exact compiled retrieval, Stage 2A feature-block pruning, Stage 2B identical posting-array skip, Stage 2C compact/lazy typed-array document views. Lazy FeatureVector skip was investigated and not shipped; see [lazy-features.md](lazy-features.md).

### Next: reduce conjunction-class work

The remaining large cost is k-of-k / partial-conjunction documents, because they are currently evaluated exactly to discover phrase adjacency, `bodyPhraseCount`, and direct/signature changes.

Future work should investigate tighter **exact** block metadata capable of proving that more of these regions cannot affect the required representative streams. Possible directions (not selected implementations):

- phrase / co-occurrence block metadata
- signature / score envelopes
- better exact upper bounds

Do not treat prefix-range aggregates, classic WAND, or sharding as the next committed slice.

### Prefix scaling

Current prefix search can still enumerate every matching term and walk every corresponding posting list. There is no prefix expansion cap, and there must not be one: historical prefix recall failures must not return.

Future exact prefix scaling should use range aggregates over the same document-ordinal grid (or an equivalent exact structure) so noncompetitive term ranges can be skipped without a recall cap.

### Representation / constant factors

At larger corpora, possible engineering directions (not promises):

- compressed sparse/dense bitmaps
- delta/varint packed postings
- cache-conscious memory layout
- SIMD / WASM / native hot paths if profiling proves JS operations dominate
- segmented / on-demand loading if browser artifact memory or download becomes limiting

## Distribution is orthogonal to query complexity

Partitioning or multi-process/Worker distribution may eventually be useful for storage footprint, memory capacity, deployment topology, throughput, or fault isolation.

It is **not** the planned answer to large-corpus query complexity. Sharding a Θ(N) or Θ(matches) query path only divides that work; it does not yield the sublinear scaling the project needs. The search algorithm should first minimize the amount of index/candidate state touched per query.

The production path remains a single compiled index. A future distribution topology would still need a separate exactness proof for corpus statistics, relationship semantics, global ranks, related rows, explanations, and custom constraints.

See [architecture.md](architecture.md), [limitations.md](limitations.md), [retrievers.md](retrievers.md), [compact-runtime.md](compact-runtime.md), and [exact-pruning.md](exact-pruning.md).
