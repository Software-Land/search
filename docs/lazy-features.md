# Lazy feature evaluation (investigation)

**Not implemented. Not a current runtime optimization.**

Production indexed `search()` still calls `extractFeatures` for every legitimate match that Stage 2A does not already bound-reject. Stage 2A remains limited to proven plain single-token body-only candidates. Multi-token / phrase queries stay on that exhaustive Stage-2C feature path.

This note keeps the bound theorem and one mixed-corpus observation so future work does not rediscover why a skip was not shipped. It is not a product feature, not a ranking change, and not a latency SLA.

## Production path

```text
compiled match enumeration
  → extractFeatures (Stage 2C compact views)
  → exact per-signature representatives
  → unchanged sparse ranker
```

There is no lazy FeatureVector evaluator, no deferred-feature mask, and no score-bound rejection in `src/`.

## Why a skip is not current work

Exact `directClass` and builtin `constraintSignature` membership can depend on **body** evidence:

- `bodyLexicalMatch > 0` can establish `weak`
- `phraseAdjacency === 1` is title/moderate; `=== 0.5` is body/score-only
- `bodyPhraseCount` bands are signature-critical when they fire

Until those are known, a document cannot be assigned its exact signature. A conservative remaining-score bound that assumes the missing body contribution therefore cannot reject the common high-match phrase class without risking a later, stronger body vector.

High-match multi-token queries may still require **Θ(matches)** exact feature evaluation for that reason.

## Conservative benchmark evidence (not an SLA)

One mixed N=25k Node run of `"virtual private network"` (same generator/seed as the compact benches, not CI) observed:

- about **10,041** legitimate matches, all fully featured
- about **276 ms** p50 on that machine
- five exact signatures; the large class was weak body overlap (about 8k documents, 10 retained at depth 10)

Absolute milliseconds are observational. Hardware, OS noise, and corpus shape move them. Do not treat 276 ms, 10,041 matches, or the class counts as contracts.

A title-first shadow bound on that same snapshot did not underestimate scores and did not false-reject representatives. Counterfactual rejection of already-title-resolved documents was small and not enough to justify a second evaluator.

## Bound theorem (future-work evidence)

After title evidence plus cheap compiled `bodyPhraseCount`:

- if title `phraseAdjacency` is already `1`, remaining body score is at most `bodyLexicalMatch × 0.25`
- otherwise remaining body score is at most `0.5 × 0.8 + 0.25 = 0.65`
- round with production `Number(score.toFixed(6))`
- ties use `document.id` as in `selectTopPerBuiltinSignature`

`classifyDirect` already returns on the first proven class. That does not skip `extractFeatures`.

Tests under `test/lazy-feature-bounds.test.js` lock those theorems against the current extractor. They do not enable a production path.

## Harness

```bash
node scripts/lazy-feature-profile.mjs --n 25000
```

Counterfactual only. Uses full `extractFeatures` as the oracle. Not packed. Not a CI latency gate.
