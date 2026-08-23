# Exact lazy feature evaluation (Stage 2D)

Investigation only. Production search still fully evaluates every legitimate match on the ordinary `search()` path, then keeps exact per-signature representatives. This document records why a further lazy FeatureVector pass is **not enabled**.

## Problem

Mixed N=25k phrase `"virtual private network"`:

- ~10,041 matches, all fully featured
- compact p50 ~276 ms
- `phraseAdjacency` itself ~29 ms after Stage 2C
- remaining cost is **10k × complete `extractFeatures`**, not ranking

The question was whether most of those documents can be rejected after a cheap exact subset of feature work, with identical representatives and public results.

## Candidate taxonomy (same mixed generator / seed as the compact benches)

| | |
| --- | --- |
| matches | 10,041 |
| exact signatures B | 5 |
| representatives retained (depth 10) | 43 |
| strong | 1,167 (title phrase / full coverage) |
| moderate | 777 |
| weak | **8,097** (one signature, 10 retained) |

The weak bucket is almost homogeneous: `queryCoverage=0`, `titleCoverage=0`, `phraseAdjacency=0` except one body-adjacent document, `bodyLexicalMatch=0.3333` except one full-body document, three distinct rounded scores (`0.083325` … `0.65`).

So the 10k set is **not** 10k unique ranking classes. It is a few title-evidence signatures plus one huge weak body-overlap class. The public top-10 only needs 10 members of that class.

## Feature dependency graph

Derived from `classifyDirect`, `constraintSignature`, and `scoreFeatures`.

| feature | signature | directClass | score | notes |
| --- | --- | --- | --- | --- |
| exactTitleMatch | A | strong | 5 | title |
| exactTitleTokenMatch | A | moderate if coverage>0; else weak | 1.6 | title |
| typedSurfaceTitleMatch | A | — | — | signature bit only |
| queryCoverage | A (bands) | strong / moderate / weak | ×2.4 | title + version |
| titleCoverage | A (band, + token count if exactish) | — | ×1.2 | title |
| titlePrefixQuality | A (bands) | strong / moderate / weak | ×1.8 | title |
| contextualTitlePrefix + quality | A | moderate | via quality when both contextual | title |
| configuredEquivalenceMatch | A | strong / moderate / weak | 1.5 / 1.2 | title |
| versionMatch | A | strong if dotted | 2.2 / 0.77 | title |
| shortLiteralLeadMatch | A | moderate | 1.7 | title |
| dottedSpanComponentTitleMatch | A | moderate | 0.9 | title |
| canonicalKeyTitle | A | strong | 1.3 | title |
| queryTokenCount | A | moderate with phrase count | — | query-local |
| bodyPhraseCount | A (band) | moderate if ≥2 and multi-token | — | **cheap map lookup** |
| relevanceKind | A | — | — | related vs direct |
| **directClass** | **A (string)** | self | — | holistic |
| phraseAdjacency **=== 1** | via class | **moderate** | 0.8 | **title** proximity |
| phraseAdjacency **=== 0.5** | score only | **no class change** | 0.4 | **body** proximity |
| bodyLexicalMatch | score only **except** `>0` → weak | weak | ×0.25 | body concepts |
| morphologyMatch | score; weak if no higher class | weak | 0.4 | **title** |
| typoDistance | score; weak if no higher class | weak | ≤0.7 | **title** |
| expansionEvidence | C/B | — | ×0.8 | title |
| retrievalScore | B; fail-closed if weight ≠ 0 | — | as weighted | Stage 2A already fail-closes |
| relationship* | fail-closed | related bit | ×0.45 | Stage 2A |

`classifyDirect` already returns on the first proven class (`strong` then `moderate` then `weak`). That does **not** skip `extractFeatures`. The expensive work runs before classification.

## Title-first bound

After title evidence + cheap `bodyPhraseCount`:

- if `phraseAdjacency` is already `1`, remaining body contribution is at most `bodyLexicalMatch × 0.25 = 0.25`
- otherwise remaining is at most `0.5×0.8 + 0.25 = 0.65`
- round with the production `Number((score).toFixed(6))`
- ties use `document.id` the same way as `selectTopPerBuiltinSignature`

Shadow on the 25k phrase query: **0 bound underestimates**, **0 false representative rejections**.

## Why production lazy evaluation is not enabled

Title-first resolves an **exact** signature for only **2,164 / 10,041** documents (the strong/moderate title hits). The other **7,877** need a body concept hit to become `weak` rather than `none`. `bodyLexicalMatch` is therefore **signature-critical** for the huge bucket, not a deferrable score term.

Once that class is known, a conservative remaining-score bound of **0.65** still dwarfs the typical weak score **~0.083**. A later document with `bodyLexicalMatch=1` or `phraseAdjacency=0.5` would beat the common `0.3333×0.25` members. The bound must not underestimate, so those body features cannot be skipped.

Streaming rejection in **current retrieve order**, depth 10:

| | full evals | lazy rejects |
| --- | --- | --- |
| current ordinal | 9,011 | 1,030 |
| document-id order | 9,011 | 1,030 |
| higher known-title-score first | 8,524 | 1,517 |

~10% fewer full vectors, almost all on title-resolved signatures where only **body** work is skipped. That is a few milliseconds, not 276 ms → 100–150 ms. Reordering is allowed only if outputs stay exact; it does not fix the weak-bucket bound.

Fallbacks (`searchDetailed` diagnostics, `explain`, relationships, `all-strong`, custom constraints, `retrievalScoreWeight ≠ 0`) would remain exhaustive anyway. The interactive `search()` path is the one that matters, and it is dominated by the unresolved weak class.

## What would still be exact but was not shipped

- Reconstruct `bodyLexicalMatch` from prefix-expanded postings instead of per-doc body scans: different mechanism, still Θ(matches) membership work, not a score-bound skip.
- Permanent doc→posting offset tables: would spend Stage-2C heap.
- Merging `bodyPhraseCount` with `phraseAdjacency`: different predicates; rejected earlier.

Leave Stage 2C production evaluation untouched.

## Harness

```bash
node scripts/lazy-feature-profile.mjs --n 25000
```

Not packed. Not a CI latency gate.
