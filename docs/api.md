# Search API

```js
engine.search(query, options?)          // SearchResult[]
engine.searchAsync(query, options?)     // Promise<SearchResult[]>
engine.searchDetailed(query, options?)  // { results, related, meta }
engine.searchDetailedAsync(...)
```

Invariant: `search(q, opts)` is semantically identical to `searchDetailed(q, opts).results`; both use the same retrieval, relationship, representative, and sparse-ranking algorithm. `searchDetailed` may additionally compute a full exact diagnostic plan for candidate titles, cycles, conflicts, and explanation successors.

`searchAsync` / `searchDetailedAsync` are the same algorithm with yields for cancellation. They must not change ordering.

## Options

| option | default | notes |
| --- | --- | --- |
| `limit` | 10 | Length of `results` |
| `relatedLimit` | 5 | Length of `related` |
| `explain` | false | Attach JSON-serializable `explanation` |
| `relationshipStrategy` | engine default | `hybrid` \| `mixed` \| `separate` \| `none` |
| `signal` | — | `AbortSignal`; abort throws `AbortError`, never `[]` |
| `candidateLimit` | engine default | Compatibility/experimental-retriever budget; exact indexed retrieval does not truncate to it |

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

Do not treat `score` as globally meaningful. Constraints dominate. `meta` on `searchDetailed` is experimental (timings, candidate counts, posting/block work, full feature evaluations, bound rejections, and pruning fallback reason). Counter names are not a stable public optimization API.

## Cancellation

A cancelled search throws (`DOMException` named `AbortError` when available). Index state is unchanged. `lastSearchMeta` is only written on success.

Synchronous `search()` only observes `signal.aborted` at checkpoints. Use `searchAsync` or the Worker when abort must interrupt in-flight work.

Pre-aborted signals throw immediately.

## Determinism

Same documents, configuration, artifacts, and query produce the same ordering, explanations, and related rail. Ties break on document id. Cross-engine floating-point bit identity is not claimed.

## Plugins (opt-in types)

`SearchEngine.create({ plugins })` accepts `SearchPlugin[]`. `morphology()` returns `EnglishPlugin`. `dictionary()` returns `DictionaryPlugin`. Custom retrievers type as `ExperimentalRetriever`. Permissive duck-typed plugin objects remain valid at runtime.

Type contracts `SearchPlugin`, `EnglishPlugin`, `DictionaryPlugin`, `SynonymPlugin`, and `LexiconPlugin` describe the duck-typed hooks Core actually reads (`lemma`, `canonicalLemma`, `lexicon`, `sequences` / `entry`, `byKey`, `expand`). They do not make analysis or ranking internals public, and they do not change runtime dispatch. `english()` is not a public root export. Custom plugins may implement `SearchPlugin.expand`; `SynonymPlugin` is that structural shape. Applications do not separately author a root `synonyms()` constructor.

## Configured concepts and relationshipMap

Configured concepts are authored as `{ key, aliases }` plus optional identity metadata (`type`, `provenance`, `confidence`). `aliases[0]` is the canonical lexical sequence (compiled internally as the existing expansion sequence). Later aliases are alternate same-intent forms. Former fields `expansion` / `exp`, `primary`, `standaloneRecall`, and `topicalRecall` are rejected on `dictionary()` entries. Those metadata fields are not ranking weights; `migrateConfiguredEntry()` emits `{ key, aliases }` only.

Once a query unambiguously occupies one configured concept, every authored spelling of that concept is the same search intent:

- the key, `aliases[0]`, and later aliases produce identical ranked results (same candidate set, IDs, order, scores, `relevanceKind`, `directClass`, and related rail)
- typed surface stays on the query for explain/provenance and must not leak into ranking
- exact configured-key identity outranks another concept's one-token alias or one-token expansion of that same typed form; two distinct exact keys still fail closed
- one-token aliases and one-token expansions occupy only on exact typed identity
- multi-token configured forms may still complete an incomplete final token when preceding tokens uniquely identify the concept (`continuous d` → `cd`)
- incomplete guessing of a configured *key* remains subject to the short-prefix information bound (`form.length < 3`)

```js
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
} from "@software-land/search";

const authored = compileAuthoredRelevance({
  entries: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
  relationshipMap: {
    hypertext: [{ to: { concept: "http" }, kind: "related" }],
    qa: [{ to: { form: "testing" }, kind: "equivalent" }],
  },
});

SearchEngine.create({
  plugins: [morphology(), ...authored.plugins],
  relationships: authored.relationships,
});
```

`authored.plugins` is the canonical ordered plugin collection. `authored.synonyms` remains the compiled low-level one-hop recall plugin for inspection; applications author `equivalent` edges and do not separately construct that plugin.

`relationshipMap` is directional. Kinds are `equivalent` and `related`. Endpoints are `{ form }`, `{ concept }`, or `{ document }`. Edges do not auto-reverse and must not carry numeric weights. Equivalent edges do not rewrite typed tokens.

| Authored edge | Compiles onto |
| --- | --- |
| `equivalent` → form or concept | existing one-hop recall machinery |
| `related` 1-token → `{ concept }` | existing standalone-recall |
| `related` concept → `{ form }` | existing topical-recall |
| `related` document → `{ document }` | existing editorial relationship artifact (`type: editorial`, provenance `manual`, strength 1) |

`dictionary({ entries })` compiles configured-concept identity only. Complete authored relevance — equivalent recall, related standalone/topical forms, and editorial document edges — is `compileAuthoredRelevance({ entries, relationshipMap, documents })`. Pass `...authored.plugins` and `authored.relationships` to `SearchEngine.create`. Browser `SearchClient.init({ relationshipMap })` uses that same full authored-relevance meaning. Generated MiniLM relationships stay in the separate semantic artifact; merge them with authored editorial edges via `mergeEditorialRelationships(semantic, authored.editorialRelationships)`.

`compileRelationshipMap()` is a lower-level/partial compiler for tooling. It does not install dictionary related-recall or produce a ready plugin set. Prefer `compileAuthoredRelevance()` for application initialization.

`normalizeSearchEquivalences(map)` is an enrichment/tooling helper. It validates directional one-hop rows (empty source/targets, source==target, unsafe symbols, max 8 targets/source). Applications merge curated and generated rows before compiling them into `relationshipMap`; Core does not rank those sources. It is not a runtime authoring constructor.

The compiled `search-v2-synonyms` `{ terms: [...] }` artifact remains a bidirectional compatibility path via `parseSynonyms()`. Do not pass a directional object map to `parseSynonyms()`.

`migrateConfiguredEntry(old)` is a one-shot conversion from `{ key, exp|expansion, aliases, primary, standaloneRecall, topicalRecall }`. Runtime `dictionary()` / `SearchEngine` do not call it. `primary` is discarded and is not mapped to any relationship.

Explain output may still name compiled `standaloneRecall` / `topicalRecall` provenance. Those are runtime/explain names, not authoring fields.
