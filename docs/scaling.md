# Scaling

Current practical browser target: **approximately 10k–25k documents**.

That is an engineering/performance target. It is not a correctness limit, a quality cliff, or a hard corpus maximum.

Stage 1 removed the old fixed-candidate quality failure. Larger N does not switch into a lower-quality retrieval mode. Exact compiled retrieval still enumerates every legitimate match, then keeps exact per-signature representatives. Stage 2A may skip full feature work only for proven classes; it does not drop matches to stay under a budget.

As N and workload grow, the current limits are:

- query-time posting work
- feature work
- artifact/load cost
- browser memory

Workload depends more directly on query document frequency, posting entries touched, prefix expansion, the number and distribution of legitimate matches, and relationship behavior than on N alone. A 25k corpus with a rare exact title can be cheap. A 5k corpus with a high-DF prefix and active relationships can be expensive.

## Roadmap

1. Exact compiled retrieval — **done** (Stage 1)
2. Exact feature pruning — **done** (Stage 2A)
3. Exact posting/block pruning — **partial** (Stage 2B identical posting-array skip; Stage 3A unread 1-of-k body-block skip on the 128-doc ordinal grid)
4. Compact/lazy typed-array runtime — **done** (Stage 2C)
5. Lazy FeatureVector skip — **investigated, not shipped**. Title-first score bounds are a documented theorem; production still fully evaluates high-match multi-token queries because exact `directClass` / constraint signatures can depend on body evidence. See [lazy-features.md](lazy-features.md).
6. Benchmark 100k / 250k / 500k / 1M
7. Build-time sharding + Worker pool if needed

Stage 2B may skip posting work only with a proof that the skipped work cannot change Stage-2A membership or output. The shipped rule skips posting arrays this query has already fully decoded. Stage 3A may additionally skip unread 1-of-k body ordinals after stronger co-occurrence classes on the shared 128-document grid have been evaluated, using additive `exact-pruning-v2` presence bits. Prefix expansion, WAND/BMW, and worker sharding remain future work. Stage 2C is a memory/runtime representation change, not a ranking change. It consumes current v1 bytes. Later corpus sizes are measurement gates, not promises. See [compact-runtime.md](compact-runtime.md) and [exact-pruning.md](exact-pruning.md).

## Stage 3A measured VPN workload

Deterministic mixed generator, seed `0x60d6e7ed`, 60-token articles, query `"virtual private network"`. Same engine/artifact, exhaustive vs Stage 3A auto. Absolute milliseconds are one Node process, not an SLA.

At N=25k Stage 3A decoded about 13.9× fewer posting entries (59,294 → 4,279), materialized and featured about 5.1× fewer documents (10,041 → 1,954), and cut p50 about 5.1× (238.5 ms → 46.3 ms on the acceptance machine). Presence-block accounting on that query is `postingBlocksTotal=196`, `postingBlocksDecoded=1`, `postingBlocksClassifiedFromMasks=195`, `postingBlocksSkippedUnread=195` (`total = decoded + classifiedFromMasks`; skippedUnread is a subset of classifiedFromMasks). Exhaustive leaves those Stage 3 fields at 0; title/body posting chunks remain on `postingBlocksVisited`. At N=100k output stayed exact; remaining competitive/conjunction work was about 4× the 25k remainder while the corpus was 4× (matches 10,041 → 40,195; materialized 1,954 → 7,792; posting entries decoded 4,279 → 17,117; p50 937 ms → 182 ms vs exhaustive).

Stage 3A’s exact accomplishment is removing the large 1-of-k body flood before decode and materialization. Remaining conjunction and partial-conjunction work still scales with its own cardinality. This VPN workload is therefore **not** flat with corpus size. Stage 3A does not claim O(1) posting work, flat scaling, or 1M/50 ms.

## Future multi-Worker topology

Exact per-signature representative merging makes sharding promising: each Worker can retain only the representatives required from its shard, then a coordinator can merge those streams and run the existing sparse ranker.

```text
                    query
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
      Worker A     Worker B     Worker C
      shard A      shard B      shard C
         │            │            │
      exact local  exact local  exact local
      representatives representatives
         └────────────┼────────────┘
                      ▼
               exact global merge
                      ▼
                 sparse ranker
```

Each Worker owns only its shard. Do not spawn Workers from a hard N threshold such as `if (N > 20000) spawn 4 Workers`. A future topology decision should consider artifact bytes, browser memory, `hardwareConcurrency`, query/posting work, and expected fully evaluated documents.

Sharding still needs a separate exactness proof for:

- corpus statistics
- relationship semantics
- global ranks
- related rows
- explanations
- custom constraints

Until that proof exists, the production path remains a single compiled index in one Worker.

See [architecture.md](architecture.md), [limitations.md](limitations.md), [retrievers.md](retrievers.md), and [exact-pruning.md](exact-pruning.md).
