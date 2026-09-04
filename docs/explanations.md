# Explanations

Pass `explain: true`. Output is JSON-serializable (no Map/Set/class instances).

```js
const { results } = engine.searchDetailed("tls", { explain: true });
results[0].explanation.retrievalSources; // e.g. ["exact-title", "configured-concept"]
results[0].explanation.features.directClass;
results[0].relationship; // on related hits
```

Stable concepts:

- `retrievalSources` — why the document entered the candidate set (`exact-title`, `title-token`, `configured-concept`, `configured-prefix-recall`, `morphology`, `version`, `body-lexical`, `equivalent-recall`, `relationship`, …)
- named `features` and `directClass` / `relevanceKind`
- `relationship`: `{ type, sourceId, sourceTitle, provenance, strength, rank }`
- constraint diagnostics when present (`constraintsVsNext`, `constraintMeta`)

Not exposed: postings lists, BM25 internals, engine class instances.

`retrievalScore` inside features is optional retrieval metadata and is **0** unless an experimental ranking weight is set (default 0; not recommended).

## Examples

**Exact / direct:** query `Bluetooth` → `retrievalSources` includes `exact-title`, `directClass: "strong"`.

**Configured concept:** query `tls` with a configured concept → `configured-concept`.

**Configured-prefix recall:** query `national` uniquely prefixes NIST's authored form but does not occupy. Ordinary lexical retrieval stays active; TLS enters through key-only `configured-prefix-recall`. Prefix-only `directClass` none candidates receive `configuredPrefixRecallScore`; documents that already have typed lexical provenance, including feature-level body/title evidence without a lexical retrieval source, do not. A unique proper prefix of the first form token (`nationa`) is weaker recall than the completed first token (`national`). A proper prefix of a skippable stop after aligned content (`national institute o`) is occupancy-transparent with the completed stop (`national institute of`); neither downgrades the occupancy already earned by `national institute`. Ambiguous prefixes such as `hypertext` attach no concept-specific recall. Independently retrieved configured-prefix-recall hits stay `direct` when a relationship is later attached; relationship-only neighbors remain `related`.

**Equivalent recall:** query `qa` with `relationshipMap` `kind: "equivalent"` → `equivalent-recall`.

**Equivalent recall:** query `qa` with `relationshipMap` `kind: "equivalent"` → `equivalent-recall`.

**Typo / prefix:** query `blutooth` or `bluet` → analysis alternatives / prefix sources; still ranked by Core, not by edit-distance as a score.

**Semantic related:** Bluetooth → Connected devices with `type: "semantic"` and builder provenance, typically on `related` when `relationshipStrategy: "separate"`.

**Editorial related:** same rail, `type: "editorial"` / `manually-related`, provenance from explicit domain relationships.

**Indexed candidate:** default production path, `retriever: "indexed"`; positional postings enumerate legitimate matching documents (Stage 3A may skip unread noncompetitive 1-of-k body-only ordinals). `retrievalSourcesForDocument()` re-validates the same named provenance rules as full scan for materialized hits. Eligible ordinary `search()` ranks those hits from packed ranking-evidence views; explain/`searchDetailed` use FeatureVectors. There is no BM25-budgeted proposal slice on this path, and provenance remains the named source set rather than a lone retrieval score.
