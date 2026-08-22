# Known limitations

- **Analyzed document memory** dominates large/long **retained** indexes. Inverted postings scale better. RSS is process resident size, not retained heap. On the checked-in deterministic article-like 25k workload, retained index heap after `index()` is well under 1 GB; that indexing step was not the old 8 GB failure. Default **full-scan search** of a high-DF term previously exhausted an 8 GB heap at **ranking** time (unordered pair reports and large JavaScript graph overlays). 0.3.1 no longer retains unordered / no-decision reports; directed constraint edges are packed; SCC uses exact CSR; reverse CSR is released before component ordering; the SCC result is reused for diagnosis. Pairwise **comparison time** remains Θ(C²); use `retriever: "indexed"` or `"adaptive"` for large corpora. Future work (not in v0): compact analysis, lazy fields, mapped artifacts.
- **No incremental index.** `index()` rebuilds.
- **No native Android package.**
- **No query-semantic retriever**, vector DB, or ANN. Measured lexical retrieval did not justify them for v0.
- **Hyphen aliases** (`wifi` vs `Wi-Fi`) need corpus decisions.
- **Adaptive threshold** is corpus- and hardware-sensitive. 1500 is a default, not a guarantee.
- **`score` is unstable.** Constraints are the correctness model.
- **Custom retrievers** are experimental; they leak internal query/index shapes.

## Future work (not started)

Compact analyzed representation, build-time lexical-index artifact, incremental updates, native ports. Do not treat those as promised.

Ranking internals (behavior-preserving; not a ranking redesign):

- Pairwise constraint evaluation remains Θ(C²). Ranking constructs the pairwise graph once rather than twice. Cycle diagnosis reuses that graph and its SCC result. Unordered pair **objects** are no longer retained. Directed edges use packed uint32 chunks rather than one JS array per edge. SCC adjacency is exact CSR; reverse CSR is not retained into ordering. `DEFAULT_CANDIDATE_LIMIT` is unchanged.
- `readySort()` re-sorts zero-indegree SCC components after each extraction. Correct, not a hot-path rewrite target.
