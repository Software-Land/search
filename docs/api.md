# Search API

```js
engine.search(query, options?)          // SearchResult[]
engine.searchAsync(query, options?)     // Promise<SearchResult[]>
engine.searchDetailed(query, options?)  // { results, related, meta }
engine.searchDetailedAsync(...)
```

Invariant: `search(q, opts)` **is** `searchDetailed(q, opts).results`. There is no second ranker.

`searchAsync` / `searchDetailedAsync` are the same algorithm with yields for cancellation. They must not change ordering.

## Options

| option | default | notes |
| --- | --- | --- |
| `limit` | 10 | Length of `results` |
| `relatedLimit` | 5 | Length of `related` |
| `explain` | false | Attach JSON-serializable `explanation` |
| `relationshipStrategy` | engine default | `hybrid` \| `mixed` \| `separate` \| `none` |
| `signal` | — | `AbortSignal`; abort throws `AbortError`, never `[]` |
| `candidateLimit` | engine default | Indexed budget override |

Unknown `relationshipStrategy` values throw `InvalidConfigurationError`.

## Result shape

```js
{
  id, title, rank,
  score,              // UNSTABLE: within-constraint number, not a calibrated score
  relevanceKind,      // "direct" | "related"
  directClass,        // "strong" | "moderate" | "weak" | "none"
  relationship?,      // present on related hits
  retrievalSources?,  // when explain: true
  explanation?,       // when explain: true
}
```

Do not treat `score` as globally meaningful. Constraints dominate. `meta` on `searchDetailed` is experimental (timings, candidate counts).

## Cancellation

A cancelled search throws (`DOMException` named `AbortError` when available). Index state is unchanged. `lastSearchMeta` is only written on success.

Synchronous `search()` only observes `signal.aborted` at checkpoints. Use `searchAsync` or the Worker when abort must interrupt in-flight work.

Pre-aborted signals throw immediately.

## Determinism

Same documents, configuration, artifacts, and query produce the same ordering, explanations, and related rail. Ties break on document id. Cross-engine floating-point bit identity is not claimed.

## Plugins (opt-in types)

`SearchEngine.create({ plugins })` remains `unknown[]`. `morphology()` returns `EnglishPlugin`. Deprecated `english()` and `dictionary()` remain `unknown`. Permissive JavaScript plugin objects are still valid.

Type-only contracts `SearchPlugin`, `EnglishPlugin`, `DictionaryPlugin`, `SynonymPlugin`, and `LexiconPlugin` are opt-in. Annotate objects you author when you want checking. They describe the duck-typed hooks Core actually reads (`lemma`, `canonicalLemma`, `lexicon`, `sequences` / `entry`, `byKey`, `expand`). They do not make analysis or ranking internals public, and they do not change runtime dispatch.
