# Known limitations

- **Analyzed document memory** dominates large/long **retained** indexes. Inverted postings scale better. A Settings-like 100k indexed catalog is a few hundred MB RSS. An article-like 25k index fits well under 8 GB; default **full-scan search** of a high-DF term previously exhausted an 8 GB heap by retaining a diagnostic object for every unordered candidate pair. 0.3.1 keeps only packed directed edges and conflict reports. Pairwise **comparison time** remains Θ(C²); use `retriever: "indexed"` or `"adaptive"` for large corpora. Future work (not in v0): compact analysis, lazy fields, mapped artifacts.
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

- Pairwise constraint evaluation remains Θ(C²). Ranking constructs the pairwise graph once rather than twice. Cycle diagnosis reuses that graph. Unordered pair **objects** are no longer retained. Directed edges use packed uint32 chunks rather than one JS array per edge. `DEFAULT_CANDIDATE_LIMIT` is unchanged.
- `readySort()` re-sorts zero-indegree SCC components after each extraction. Correct, not a hot-path rewrite target.
