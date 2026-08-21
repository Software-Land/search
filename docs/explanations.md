# Explanations

Pass `explain: true`. Output is JSON-serializable (no Map/Set/class instances).

```js
const { results } = engine.searchDetailed("tls", { explain: true });
results[0].explanation.retrievalSources; // e.g. ["exact-title", "configured-equivalence"]
results[0].explanation.features.directClass;
results[0].relationship; // on related hits
```

Stable concepts:

- `retrievalSources` — why the document entered the candidate set (`exact-title`, `title-token`, `configured-equivalence`, `morphology`, `version`, `body-lexical`, `indexed-lexical`, `relationship`, …)
- named `features` and `directClass` / `relevanceKind`
- `relationship`: `{ type, sourceId, sourceTitle, provenance, strength, rank }`
- constraint diagnostics when present (`constraintsVsNext`, `constraintMeta`)

Not exposed: postings lists, BM25 internals, engine class instances.

`retrievalScore` inside features is optional retrieval metadata and is **0** unless an experimental ranking weight is set (default 0; not recommended).

## Examples

**Exact / direct:** query `Bluetooth` → `retrievalSources` includes `exact-title`, `directClass: "strong"`.

**Configured equivalence:** query `tls` with a dictionary entry → `configured-equivalence`.

**Typo / prefix:** query `blutooth` or `bluet` → analysis alternatives / prefix sources; still ranked by Core, not by edit-distance as a score.

**Semantic related:** Bluetooth → Connected devices with `type: "semantic"` and builder provenance, typically on `related` when `relationshipStrategy: "separate"`.

**Editorial related:** same rail, `type: "editorial"` / `manually-related`, provenance from explicit domain relationships.

**Indexed candidate:** large corpus, `retriever: "indexed"`; provenance still uses named sources, not a lone BM25 number.
