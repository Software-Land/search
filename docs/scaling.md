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
3. Exact posting/block pruning — **partial** (Stage 2B identical posting-array skip; unread blocks remain)
4. Compact/lazy typed-array runtime — **done** (Stage 2C)
5. Benchmark 100k / 250k / 500k / 1M
6. Build-time sharding + Worker pool if needed

Stage 2B may skip posting work only with a proof that the skipped work cannot change Stage-2A membership or output. The shipped rule skips posting arrays this query has already fully decoded. Unread posting blocks remain unpruned. Stage 2C is a memory/runtime representation change, not a ranking change. It consumes current v1 bytes. Later corpus sizes are measurement gates, not promises. See [compact-runtime.md](compact-runtime.md).

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
