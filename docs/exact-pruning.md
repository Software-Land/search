# Exact pruning design

Stage 1 remains the oracle:

```text
exhaustive compiled match enumeration
  → exact features/signatures/scores
  → exact per-signature representatives
  → unchanged sparse ranker
```

Stage 2 may omit work only when the omitted candidates cannot change that result. The first implementation is deliberately **Stage 2A document-feature block pruning**. It still enumerates and re-validates every matching posting/document membership. It avoids full `extractFeatures()` work only for a narrow candidate class with an exact query-time signature and score proof. Posting-entry skipping and compact/lazy runtime storage remain Stage 2B/2C.

## Preserved state

For builtin constraints, the pruned path must preserve the first `representativeDepth` candidates in every reachable exact signature, ordered by:

1. `Number(scoreFeatures(features).toFixed(6))`, descending
2. `document.id`, ascending

A block is not prunable if it can introduce an unseen signature, has fewer than `representativeDepth` established members in any reachable signature, can exceed that signature's worst retained rounded score, or can tie that score with a smaller id.

Public `searchDetailed()` uses exhaustive compiled evaluation so its complete candidate titles, cycles, conflicts, and related diagnostics stay unchanged. An internal exhaustive mode is also retained for direct pruned-versus-compiled differential tests.

## Pruning unit and layout

The v1 extension uses deterministic **document-ordinal blocks**. Document ordinals already follow sorted canonical ids, so the first ordinal in a block is also its minimum possible id tie bound.

The selected block size is 128 documents:

- 32: tighter envelopes but four times as many boundaries/checks as 128.
- 64: useful diagnostic granularity, but twice the metadata/checks of 128.
- 128: small additive metadata, enough blocks for progressive heap saturation, and aligned with the existing flat-array/typed-array direction.
- 256: less metadata, but delays saturation and mixes more bounded/unbounded documents.

Block size is not a quality parameter. Every supported size uses the same exact predicate, and unsupported candidates inside a block are evaluated normally.

Stage 2A stores only contiguous block boundaries. It does not claim TF/score bounds that it cannot yet prove.

## Feature and signature audit

| Feature | Exact per-document source | Stage 2A block fact/bound | Signature/score consequence | Stage 2A action |
| --- | --- | --- | --- | --- |
| `exactTitleMatch` | normalized query and `normalizedTitle` | absent only after exact provenance recheck proves body-only | signature bit; +5 | otherwise evaluate |
| `exactTitleTokenMatch` | independent title tokens | body-only provenance excludes canonical title token evidence | signature bit; +1.6 | otherwise evaluate |
| `typedSurfaceTitleMatch` | typed surface vs independent title tokens/prefixes | require unrepaired single-token surface equal to canonical token; body-only provenance excludes the match | signature bit only | otherwise evaluate |
| `titleCoverage` | title tokens/components vs query forms | body-only provenance excludes exact/prefix/lemma title concepts for the supported query | signature band; +1.2× | otherwise evaluate |
| `queryCoverage` | query concepts evidenced in title/version | supported candidate has one non-number/non-acronym concept and no title/version provenance | signature band; +2.4× | otherwise evaluate |
| `titlePrefixQuality` | query/title prefix coverage and title tightness | body-only provenance excludes supported canonical prefix; short lead is checked separately | signature band; +1.8× | otherwise evaluate |
| contextual prefix fields | aligned multi-token title prefix | supported path requires one query token | signature bit/scalar | multi-token queries evaluate |
| configured equivalence | acronym key/expansion in title | supported path rejects acronym concepts | signature band; +1.5× | configured queries evaluate |
| `morphologyMatch` | query lemma in title without surface | body-only provenance would report title morphology | score +0.4; may affect class | otherwise evaluate |
| `typoDistance` | title token edit/repeat evidence | unrepaired tokens use a cheap exact title-token distance probe; any possible nonzero value forces evaluation | score up to +0.7; may affect class | otherwise exact zero |
| `versionMatch` | compact/dotted forms and companion coverage | supported path rejects number/dotted queries; body-only provenance excludes version title evidence | signature band; up to +2.2 | version queries evaluate |
| `shortLiteralLeadMatch` | first title token | explicitly require first token not equal to/start with the short query | signature bit; +1.7; moderate class | otherwise evaluate |
| dotted component | dotted title spans/components | supported path rejects numeric/dotted queries | signature bit; +0.9 | otherwise evaluate |
| `phraseAdjacency` | positional title/body token streams | one-token query has no adjacency feature | score +0 | multi-token queries evaluate |
| `bodyLexicalMatch` | query concepts vs body tokens/lemmas/prefixes | exact `1` for one concept with sole `body-lexical` provenance | score exactly +0.25 | exact bound |
| body phrase count/frequency | attached `lexicalFrequency` | exact lookup of the sole canonical phrase key, or zero after stop stripping | signature phrase-count band; no score term | exact envelope |
| `titleTokenCount` | non-stop title count | irrelevant in the supported non-exactish signature | conditional signature scalar; no score | no bound needed |
| expansion/canonical key | configured expansion title evidence | supported path rejects acronym/configured-key concepts | signature bit / up to +2.1 | otherwise evaluate |
| `retrievalScore` | normalized retriever score × configured weight | supported only when `retrievalScoreWeight === 0` | additive score | nonzero weight evaluates |
| relationship fields | selected edge | supported candidate initially direct with strength 0 | signature relevance/class; +0 | active relationship targets evaluate/fallback |
| `directClass` / `relevanceKind` | all evidence above | exactly `weak` / `direct` for supported candidates | signature fields | exact bound |

## Supported exact envelope

Stage 2A bounds a retrieved candidate only when all of these are proven:

- exact compiled indexed retriever and a valid pruning extension
- builtin ranking and non-diagnostic result path
- `retrievalScoreWeight === 0`
- one unrepaired, non-number, non-acronym query token; longer tokens must have no exact title-token typo evidence
- no dotted/version or inferred prefix-completion state
- exact rechecked provenance is only `body-lexical`
- the first title token cannot produce `shortLiteralLeadMatch`
- no pre-existing relationship on the hit

For such a candidate the complete ranking-relevant state is:

```text
exact/title/prefix/equivalence/morphology/typo/version/dotted/adjacency = 0
queryCoverage = titleCoverage = 0
bodyLexicalMatch = 1
queryTokenCount = 1
directClass = weak
relevanceKind = direct
retrievalScore = relationshipStrength = 0
bodyPhraseCount = exact attached-frequency lookup (often 0)
rounded score = 0.250000
```

The reachable signature envelope for a block is the exact set of phrase-count bands present among its supported candidates. Any unsupported candidate is outside this envelope and is fully evaluated; it can introduce any signature without being hidden by the bound.

## Exact prune predicate

For each exact signature `S` reachable among the bounded candidates in a document block:

1. If fewer than `representativeDepth` members of `S` are retained, inspect the bounded candidates.
2. If the block's exact maximum rounded score for `S` exceeds the worst retained score, inspect them.
3. If the score ties and the block's minimum candidate id is smaller than the worst retained id, inspect them.
4. Otherwise the bounded candidates of `S` cannot enter its required stream.

The block's bounded subset may be skipped only when this is true for every reachable bounded signature. Unsupported documents in the same block are still evaluated.

Because document ordinals are sorted by id, late equal-score blocks normally fail the tie test in the prunable direction: their minimum id is greater than the ids already retained. The runtime still applies the explicit score/id predicate rather than relying on traversal order.

## Multi-term and prefix strategy

Stage 2A does not prune multi-term, prefix-completed, contextual-prefix, morphology-sensitive, typo-sensitive, configured-equivalence, version, or dotted queries. Those cases can combine evidence from several posting lists and create coverage, adjacency, or previously unseen stronger signatures. They remain exhaustive.

This fail-closed rule also means there is no term-range cap or approximate prefix truncation. Exact prefix expansion remains unchanged.

Future posting-block skipping must operate on a merged query-level document-ordinal view (or an equivalently conservative cross-list envelope), not independently on one term posting list.

## Relationship policy

- `all-strong`: exhaustive.
- `top1-strong` / `top-n-strong`: bounded candidates are proven weak and cannot be primaries. The engine first evaluates all unbounded candidates and selects the exact primary stream.
- If any selected primary owns relationship edges, Stage 2A falls back to exhaustive feature evaluation. This preserves existing-target membership, weak-to-related reclassification, missing-neighbor addition, and related global ranks.
- If no selected primary has edges, relationship expansion cannot observe omitted bounded candidates and pruning is allowed.

This conservative first implementation does not attempt lazy materialization of relationship targets.

## Artifact extension

The integrity-covered v1 namespace contains:

```json
{
  "exact-pruning-v1": {
    "revision": 1,
    "unit": "document-ordinal",
    "blockSize": 128,
    "boundaries": [0, 128, 256]
  }
}
```

The final boundary is the document count. Known-extension corruption, gaps, overlap, invalid sizes, or unsupported revisions reject. Unknown unrelated extension keys retain the existing additive behavior. An old v1 artifact without `exact-pruning-v1` loads and runs exhaustive Stage 1 behavior.

## Fallback conditions

Pruning is disabled for:

- public full diagnostics or explicit exhaustive test mode
- old artifacts without the extension
- full-scan, legacy/unknown/custom retrievers, or custom constraints
- nonzero retrieval-score ranking weight
- unsupported query/evidence combinations
- `all-strong`
- active relationship expansion
- any malformed or uncertain bound state

Failing to prove eligibility is not an error; it means full Stage 1 evaluation. Malformed claimed extension metadata is an artifact error.

## Stage 2B/2C boundary

Stage 2A can dramatically reduce full feature/signature work for common body-only floods, but it reports zero posting entries skipped because membership enumeration remains exhaustive. Stage 2B must add conservative cross-posting TF/field/evidence summaries before skipping posting entries. Stage 2C may replace hydrated Sets/Maps/token arrays with compact/lazy views; it is intentionally separate from this proof. See [scaling.md](scaling.md).
