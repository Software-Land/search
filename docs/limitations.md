# Known limitations

- **Analyzed document memory** dominates large/long corpora. Inverted postings scale better. A Settings-like 100k indexed catalog used about 594 MB RSS; an article-like 25k corpus OOM’d an 8 GB Node heap. Future work (not in v0): compact analysis, lazy fields, mapped artifacts.
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

- Pairwise constraint evaluation remains Θ(C²). Ranking now constructs the pairwise graph once rather than twice. Cycle diagnosis reuses that graph. `DEFAULT_CANDIDATE_LIMIT` is unchanged.
- `readySort()` re-sorts zero-indegree SCC components after each extraction. Correct, not a hot-path rewrite target.
