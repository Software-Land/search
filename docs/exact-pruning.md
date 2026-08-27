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
| configured concept | acronym key/expansion in title | supported path rejects acronym concepts | signature band; +1.5× | configured queries evaluate |
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

Stage 2A does not prune multi-term, prefix-completed, contextual-prefix, morphology-sensitive, typo-sensitive, configured-concept, version, or dotted queries. Those cases can combine evidence from several posting lists and create coverage, adjacency, or previously unseen stronger signatures. They remain exhaustive.

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

## Stage 3A unread body-block skipping

Stage 3A is **shipped**. It is additive `exact-pruning-v2` metadata on the same 128-document ordinal grid as v1. For each body term whose postings span more than one ordinal block, the compiler stores four uint32 presence words per occupied block. Bit i means document `blockStart+i` contains that term in body. Single-block lists omit masks; queries that need those terms reconstruct presence from the list itself only when it still occupies one block.

Supported `search()` path: builtin ranking, compiled indexed retriever, exact multi-token query with ≥2 unrepaired non-number term concepts, `retrievalScoreWeight === 0`, not `all-strong`, not diagnostics/explain-exhaustive. Title postings are always walked. Body  k-of-k and (k-1)..2-of-k ordinals are always evaluated so phrase adjacency / `bodyPhraseCount` can mint signatures. After those classes fill the weak representative stream to `representativeDepth`, remaining 1-of-k body-only ordinals are skipped without posting decode, materialization, provenance, or `extractFeatures`.

Skip is exact: unread 1-of-k members cannot beat a full same-signature heap on rounded `scoreFeatures` then `document.id`. Document ordinals follow sorted ids, so later unread equal-score ids lose the tie. Missing, single-block-only, or malformed v2 metadata fails closed (omit extension → exhaustive; claimed malformed → load reject). `searchDetailed()` stays exhaustive.

Prefix expansion, classic WAND/BMW, and approximate top-K are out of scope. Stage 3A is shipped exact signature-aware unread-block skipping, not a global-threshold WAND/MaxScore walker. Corpus sharding is not the query-scaling plan; see [scaling.md](scaling.md).

### Stage 3A block counters

Stage 3A `postingBlocks*` fields count unique **128-document ordinal body-presence blocks** for the query (v2 masks, or synthesized from a still-single-block body list). They do not count title posting chunks, duplicate already-walked arrays, or class-pop masks as if those were physical blocks.

| field | meaning |
| --- | --- |
| `postingBlocksTotal` | unique presence blocks |
| `postingBlocksDecoded` | presence blocks whose **body posting payloads** were walked |
| `postingBlocksClassifiedFromMasks` | presence blocks classified from v2 bits without walking body postings |
| `postingBlocksSkippedUnread` | presence blocks that still contain skipped 1-of-k docs whose body postings were never walked |

Invariant: `postingBlocksTotal = postingBlocksDecoded + postingBlocksClassifiedFromMasks`.

`postingBlocksSkippedUnread` is a subset of `postingBlocksClassifiedFromMasks`. It is **not** added into that sum. One presence block can contain both evaluated conjunction docs (from bits, no body-list walk) and skipped 1-of-k docs.

Stage 2B remains separate:

- `duplicatePostingEntriesAvoided` — posting entries not re-decoded because this query already walked that array
- `postingBlocksSkipped` — legacy name; `ceil(df/128)` of those duplicate arrays. Same value as `duplicatePostingBlocksAvoided`
- `postingBlocksVisited` — `ceil(entries/128)` of posting arrays actually walked this query, including title

Title walks stay on `postingBlocksVisited` / `postingEntriesVisited` and are not added into Stage 3 `postingBlocksDecoded`.

## Stage 2B/2C boundary

Stage 2A can dramatically reduce full feature/signature work for common body-only floods.

Stage 2B production pruning is only **identical posting-array rewalks**: if this query has already decoded a compiled `title`/`body` posting `number[]`, later token, concept, lemma, or contextual lanes that point at the same array are not decoded again. Membership and `retrievalSourcesForDocument` provenance stay exhaustive. Default ranking is unchanged because `retrievalScoreWeight` defaults to `0`.

Stage 3A may skip unread 1-of-k body regions after stronger co-occurrence classes on the shared document-ordinal grid have been evaluated. A block still cannot be dropped merely because a term-local posting envelope looks weak: unseen signatures, phrase/direct-class jumps, and title evidence force evaluation. Multi-term evidence is never proven from “all terms occur somewhere in this 128-doc block”; Stage 3A uses per-document presence bits.

Prefix expansion stays exhaustive. Historical prefix recall failures must not return. Dictionary-range metadata may later accelerate lookup; it must not cap terms.

Nonzero `retrievalScoreWeight` fail-closes to the exhaustive posting walk so BM25 reconstruction stays Stage-1 identical. Active relationships keep Stage-2A's fail-closed feature policy; duplicate-list skip still returns the full lexical membership set.

Stage 2B itself still has no version bump: identical-array skip is query-time identity. Stage 3A adds the additive `exact-pruning-v2` extension described above; older artifacts without it remain exhaustive. Stage 2C replaces hydrated Sets/Maps/token arrays with compact/lazy views over the same v1 bytes; it does not change the Stage 2B proof. See [scaling.md](scaling.md) and [compact-runtime.md](compact-runtime.md).
