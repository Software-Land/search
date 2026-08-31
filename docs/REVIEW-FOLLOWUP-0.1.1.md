# Review follow-up (v0.1.1 patch, version not bumped)

> **Historical.** This note records a static-review follow-up for public `@software-land/search@0.1.0`. It is not current API, ranking, or retrieval documentation. For the present 0.6 contract see [api.md](api.md), the package [README](../README.md), and [CHANGELOG.md](../CHANGELOG.md).

External static review of public `@software-land/search@0.1.0`. Each finding was reproduced with a failing regression or by reading the shipped code before any patch. Version remains **0.1.0**. Tag `v0.1.0` was not moved.

Regressions live in `test/search-regressions.test.js`.

## 1. Relationship primary selection

**CONFIRMED_FIXED**

**Root cause.** `_expandAndFeature()` extracted features for direct hits but did not rank them before `applyRelationshipExpansion()`. `pickPrimariesForExpansion()` sorted strong directs by `(b.score || 0) - (a.score || 0)` then document id. Scores were still undefined, so `top1-strong` chose the lexicographically smallest id.

Final `rankCandidates()` still placed the exact-title hit first in `results`, so the bug was the **expansion source**, not the published result list. Query `bluetooth` with `a-guide` / `Bluetooth Guide` vs `z-exact` / `Bluetooth` produced `results[0].id === "z-exact"` and `meta.primaryId === "a-guide"`, with related neighbors taken from `a-guide`.

**Regression.** `test/search-regressions.test.js`:

- unit: unsored strong directs → Search Core order (`z-exact`, not `a-guide`)
- engine sync + async: `results[0].id`, `meta.primaryId`, and `relationshipStrategy: "separate"` related rail from `z-exact` only
- `all-strong` / `top-n-strong`: `primaryIds[0] === "z-exact"`

**Change.** `pickPrimariesForExpansion()` now orders eligible strong DIRECT candidates with `rankCandidates()` (same constraint graph + score + id semantics as Search Core). SearchEngine passes `constraintsForStrategy(strategy)`. No second ranking formula; no circular import (`relationships.js` → `rank.js` only).

Assigning `scoreFeatures` and sorting by score was rejected: that still diverges from the constraint partial order.

**API / behavior.** Public API unchanged. Related rails seeded from `top1-strong` now follow Search Core ranking when several strong directs exist. Ranking of `results` was already constraint-based and is unchanged.

**Performance.** One extra `rankCandidates()` over the strong-direct subset (typically tiny). Not used in scoring weights.

## 2. Typo tie determinism

**CONFIRMED_FIXED**

**Root cause.** `suggestTypoForms()` updated the winner only when `d < best.distance`, so equal-distance ties kept the first iterated vocabulary form. `Set` / corpus insertion order changed the correction.

**Regression.** Two equal-distance forms (`planet`/`planes` on token `planex`; corpus `Alpha Guide` / `Aloha Guide` on `altha`) in both vocabulary and document-order permutations. After the fix: identical correction and identical search ids. Lexical winner is the smaller form (`planes`, `aloha`).

**Change.** Equal distance keeps the lexicographically smaller candidate form. Independent of document id and insertion order. Thresholds (`length ≥ 5`, distance 1–2) unchanged.

**API / behavior.** Public API unchanged. Only equal-distance ties change, and only to a stable lexical choice.

## 3. Duplicate-id stale vocabulary

**CONFIRMED_FIXED**

**Root cause.** `buildIndex()` last-write-wins in `byId`, but `titleTokenSet` accumulated tokens from every input row **before** duplicate ids were resolved. An overwritten title left tokens in the typo lexicon.

**Regression.** Same id twice; first title `Xylophone Manual`, final title `Bluetooth`. `titleTokenSet` must not contain `xylophone`; `xylophane` must not typo-correct.

**Change.** Analyze all inputs into `byId`, sort the finalized documents by id, then build `titleTokenSet` from that collection only. Last-document-wins preserved.

**API / behavior.** Public API unchanged. Typo vocabulary now matches the indexed document set.

## 4. Custom retriever async contract

**CONFIRMED_FIXED**

**Root cause.** Public `index.d.ts` marks `retrieveAsync` optional. `searchDetailedAsync()` always called `this.retriever.retrieveAsync(...)`. A valid `{ retrieve }` object made `search()` work and `searchAsync()` throw `TypeError`.

**Regression.** Retrieve-only custom retriever: `search("bluetooth")` works; `searchAsync()` returns the same ids; pre-aborted `AbortSignal` still throws `AbortError`.

**Change.** If `retrieveAsync` is a function, await it; otherwise call `retrieve()`. `throwIfAborted(signal)` runs immediately before and after that call. Public type still has `retrieveAsync?`. `retrieveAsync` was not made mandatory.

**API / behavior.** Aligns runtime with the existing public type. Experimental custom retrievers only. Built-in retrievers unchanged.

## 5. `relationshipMs`

**CONFIRMED_FIXED**

**Root cause.** Expansion ran inside the feature timer. Both sync and async paths hardcoded `relationshipMs: 0`.

**Regression.** With expansion, `relationshipMs > 0` and `featureMs > 0` (deterministic `performance.now` stub). `relationshipStrategy: "none"` still reports `relationshipMs === 0`. Sync and async share `_expandAndFeature()`.

**Change.** Feature extraction and relationship expansion are timed separately inside `_expandAndFeature()`. Timings are diagnostic only; they do not affect ranking.

**API / behavior.** Experimental `meta.relationshipMs` now means expansion (+ related-hit feature extraction). `meta.featureMs` is direct-candidate feature extraction only.

## 6. Performance observations

### A. Constraint graph rebuilt for cycle diagnosis

**CONFIRMED_DEFERRED**

**Root cause.** `rankCandidates()` calls `buildConstraintGraph()`, then `orderFromGraph()` calls `detectConstraintCycles()`, which builds the same pairwise graph again.

**Why deferred.** Behavior is correct. Deduplicating would touch the ranking internals for speed only. Not obviously worth the risk in a correctness patch.

### B. `readySort()` after each SCC extraction

**CONFIRMED_DEFERRED**

**Root cause.** Kahn extraction re-sorts the zero-indegree SCC list after every pop so the next component is the best score/id among currently ready nodes.

**Why deferred.** The re-sort is the determinism rule, not a bug. Caching `bestOf` would be an optimization only.

Documented under future work in `docs/limitations.md`. No ranking rewrite.

## 7. CI

**CONFIRMED_FIXED** (new)

`.github/workflows/ci.yml`: `push` / `pull_request` to `main`, Node 22, `npm ci`, `npm run typecheck`, `npm test`, `npm run smoke:import`, `npm pack --dry-run`. No publish job, no npm credentials, no model downloads. `ubuntu-latest` provides `python3` for `npm test`.

## Gates (this patch, version still 0.1.0)

```
npm ci
npm run typecheck
npm test
npm run smoke:import
npm pack --dry-run
```

All passed.

### Test totals

| suite | result |
| --- | --- |
| Jest | **159 passed**, 12 suites |
| Python (`tools/search-semantic/tests`) | **7 passed** |
| **`npm test` combined** | **166 passed** |

New Jest file `test/search-regressions.test.js`: **9 tests** covering reversed-id relationship source, sync/async primary parity, typo tie order independence, duplicate-id vocabulary, retrieve-only `searchAsync()`, and `relationshipMs`.

Not done: version bump, tag, publish, retune ranking, change artifact versions.

PATCH_0_1_1_READY_FOR_VERSION_BUMP
