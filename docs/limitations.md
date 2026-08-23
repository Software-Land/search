# Known limitations

- **Compiled-index memory remains object-heavy.** `search-v2-lexical-index` v1 stores compact positional rows on disk, but the runtime currently reconstructs per-document token arrays, sets, and position maps for the unchanged feature extractor while retaining the required posting arrays. The validated envelope and document tuples are released after initialization, but the hydrated object view still duplicates some posting-derived information. It is the Stage-1 correctness baseline, not the final memory layout. Compact/lazy feature views and mapped artifacts remain future work.
- **Complete `searchDetailed()` diagnostics still require a full ranking plan.** Normal `search()`/Worker results use exact representative reduction, but Stage 1 computes the full ordered candidate plan when the public diagnostic API must reproduce candidate titles, cycle membership, conflict cardinality, absolute ranks, and explanation successors. A future implementation can derive these from signature cardinalities and ordered bucket streams without changing their semantics.
- **High-DF posting work is still Θ(matches).** The exact indexed retriever enumerates every legitimate match and performs no WAND, MaxScore, block skipping, or posting early termination. Per-signature selection reduces final ranker input, not Stage-1 posting/feature work. `candidateLimit` is no longer an exactness bound.
- **Relationship channels can require deep representatives.** Public direct and related rows expose absolute global `rank`; explain rows also expose `constraintsVsNext`. Preserving those values may require retaining the complete global prefix through the deepest requested channel row, so `representativeDepth` can exceed `max(limit, relatedLimit)`.
- **Analyzed document and ranking memory.** RSS is process resident size, not retained heap. 0.3.1 removed the old Θ(C²) retained pair reports and packed the remaining constraint graph. 0.4.0 builtin ranking compares signatures (B) in the common case; worst case remains Θ(C²) when B = C or constraints are custom. Pass `retriever: "full-scan"` only as an explicit small-corpus/reference mode.
- **No incremental index.** `index()` rebuilds.
- **No native Android package.**
- **No query-semantic retriever**, vector DB, or ANN. Measured lexical retrieval did not justify them for v0.
- **Hyphen aliases** (`wifi` vs `Wi-Fi`) need corpus decisions.
- **Adaptive threshold** is corpus- and hardware-sensitive. 1500 is a default, not a guarantee.
- **`score` is unstable.** Constraints are the correctness model.
- **Custom retrievers** are experimental; they leak internal query/index shapes.

## Future work (not started)

Compact analyzed representation, conservative exact block pruning, incremental updates, native ports. Do not treat those as promised.

Ranking internals (behavior-preserving; not a ranking redesign):

- Builtin ranking groups candidates by constraint signature and compares O(B²) signature pairs. Exact indexed retrieval first keeps a proven per-signature prefix; custom constraint functions fail closed to all candidates. Cycle diagnosis for the pairwise path reuses that graph and its SCC result. Unordered pair **objects** are no longer retained. Directed edges use packed uint32 chunks rather than one JS array per edge. SCC adjacency is exact CSR; reverse CSR is not retained into ordering. `DEFAULT_CANDIDATE_LIMIT` remains an accepted compatibility constant, not an exact retrieval budget.
- Ready components are extracted with a binary heap keyed by best candidate score, then `document.id`. Incomparable buckets interleave; they are not concatenated.
