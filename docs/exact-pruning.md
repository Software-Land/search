# Exact pruning design

Exhaustive compiled evaluation remains the correctness reference:

```text
exhaustive compiled match enumeration
  → exact features/signatures/scores
  → exact per-signature representatives
  → unchanged sparse ranker
```

An exact search optimization may omit work only when the omitted candidates cannot change that result. **Feature block pruning** still enumerates and re-validates every matching posting and document membership. It avoids full feature calculations for eligible candidates proven unable to enter the required representative prefixes. Duplicate posting-list skipping and the compact lexical runtime are separate capabilities.

**Body posting pruning** uses body-term presence masks to avoid reading noncompetitive body posting entries. Feature block pruning and body posting pruning are separate capabilities. A current artifact can carry both extensions, either one, or neither. Packed ranking evidence, feature block pruning, and body posting pruning each have their own eligibility rules. Carrying both extensions does not mean both run for every query.

Packed ranking evidence handles an ordinary `search()` / `searchAsync()` call only when its fallback reason is absent. `explain: true` is one of those reasons, so an explained call leaves the packed path and continues through retrieval. Public `searchDetailed()` / `searchDetailedAsync()` are exact diagnostics and also leave that path. Explicit exhaustive mode leaves it too.

Feature block pruning does not consult `explain`. Ordinary `search()` / `searchAsync()` with `explain: true` still use it when the call is otherwise eligible: compiled indexed retriever, block-boundaries extension, `retrievalScoreWeight === 0`, and not `all-strong` while a relationship strategy is active. It still bounds only the proven single-token body-only class. When `explain` is set and the public depth is positive, `representativeDepth` starts one above `max(limit, relatedLimit)` so the explained successor stays in the retained prefix. Public `searchDetailed()` / `searchDetailedAsync()` set exact diagnostics, and `featureBlockPruningFallbackReason` returns `exact-diagnostics` for that call. Explicit exhaustive mode returns `explicit-exhaustive`. The test “pruned, exhaustive compiled, full-scan, sync, async, and explain rows are exact” runs both `explain` values with exact diagnostics off and records `documentsBoundRejected` for both; the following `searchDetailed()` call records `pruningFallbackReason: "exact-diagnostics"` and `documentsBoundRejected: 0`.

Body posting pruning is attached when exact diagnostics are off, pruning mode is `auto`, `retrievalScoreWeight === 0`, and the source policy is not `all-strong`. `explain: true` is not part of that condition, so an ordinary explained search can still skip unread 1-of-k body ordinals on the supported exact multi-token class. That call uses the same representative depth, including the extra explained successor. Public `searchDetailed()` does not attach it. Explicit exhaustive mode does not attach it. A query that `bodyPostingPruningUnsupportedReason()` rejects stays exhaustive even when the session gate is open.

## Preserved state

For builtin constraints, the pruned path must preserve the first `representativeDepth` candidates in every reachable exact signature. `compareBoundCandidates()` orders eligible feature block pruning candidates by:

1. Rounded score, `Number(scoreFeatures(features).toFixed(6))`, descending
2. `bodyPhraseCount`, descending
3. `document.id`, ascending

A later-id candidate can win an equal-score comparison through a higher body phrase count. The phrase-count signature band is coarser than that raw count: `0`, a positive count below `REPEATED_BODY_PHRASE_MIN` (`2`), and `2` or more. Counts inside the repeated band share a signature and still order by the raw count before id.

Within one signature, retained members stay sorted by that comparator and are capped at `representativeDepth`. A later block's bounded members of that signature are skipped only when the retained list is already full and `compareBoundCandidates(bestIncoming, worstRetained) >= 0`: the best incoming candidate does not sort ahead of the worst retained candidate. An equal comparison does not displace the worst retained member. A block's bounded subset stays when any reachable signature fails that test. An unsupported candidate is outside the bound and is fully evaluated.

Public `searchDetailed()` uses exhaustive compiled evaluation so its complete candidate titles, cycles, conflicts, and related diagnostics stay unchanged. An internal exhaustive mode is also retained for direct pruned-versus-compiled differential tests.

## Pruning unit and layout

The `exact-pruning-block-boundaries` extension uses deterministic **document-ordinal blocks**. Document ordinals already follow sorted canonical ids, so the first ordinal in a block is also its minimum possible id tie bound.

The selected block size is 128 documents:

- 32: tighter envelopes but four times as many boundaries/checks as 128.
- 64: useful diagnostic granularity, but twice the metadata/checks of 128.
- 128: small additive metadata, enough blocks for progressive heap saturation, and aligned with the existing flat-array/typed-array direction.
- 256: less metadata, but delays saturation and mixes more bounded/unbounded documents.

Block size is not a quality parameter. Every supported size uses the same exact predicate, and unsupported candidates inside a block are evaluated normally.

Feature block pruning stores only contiguous block boundaries. It does not claim TF or score bounds that it cannot yet prove.

## Feature and signature audit

| Feature | Exact per-document source | Block fact or bound | Signature or score consequence | Action |
| --- | --- | --- | --- | --- |
| `exactTitleMatch` | normalized query and `normalizedTitle` | absent only after exact provenance recheck proves body-only | signature bit; +5 | otherwise evaluate |
| `exactTitleTokenMatch` | independent title tokens | body-only provenance excludes canonical title token evidence | signature bit; +1.6 | otherwise evaluate |
| `typedSurfaceTitleMatch` | typed surface vs independent title tokens/prefixes | require unrepaired single-token surface equal to canonical token; body-only provenance excludes the match | signature bit only | otherwise evaluate |
| `titleCoverage` | title tokens/components vs query forms | body-only provenance excludes exact/prefix/lemma title concepts for the supported query | signature band; +1.2× | otherwise evaluate |
| `queryCoverage` | query concepts evidenced in title/version | supported candidate has one non-number/non-configured-concept concept and no title/version provenance | signature band; +2.4× | otherwise evaluate |
| `titlePrefixQuality` | query/title prefix coverage and title tightness | body-only provenance excludes supported canonical prefix; short lead is checked separately | signature band; +1.8× | otherwise evaluate |
| contextual prefix fields | aligned multi-token title prefix | supported path requires one query token | signature bit/scalar | multi-token queries evaluate |
| configured concept | configured key/expansion in title | supported path rejects configured-concept occupancy | signature band; +1.5× | configured queries evaluate |
| `morphologyMatch` | query lemma in title without surface | body-only provenance would report title morphology | score +0.4; may affect class | otherwise evaluate |
| `typoDistance` | title token edit/repeat evidence | unrepaired tokens use a cheap exact title-token distance probe; any possible nonzero value forces evaluation | score up to +0.7; may affect class | otherwise exact zero |
| `versionMatch` | compact/dotted forms and companion coverage | supported path rejects number/dotted queries; body-only provenance excludes version title evidence | signature band; up to +2.2 | version queries evaluate |
| `shortLiteralLeadMatch` | first title token | explicitly require first token not equal to/start with the short query | signature bit; +1.7; moderate class | otherwise evaluate |
| dotted component | dotted title spans/components | supported path rejects numeric/dotted queries | signature bit; +0.9 | otherwise evaluate |
| `phraseAdjacency` | positional title/body token streams | one-token query has no adjacency feature | score +0 | multi-token queries evaluate |
| `bodyLexicalMatch` | query concepts vs body tokens/lemmas/prefixes | exact `1` for one concept with sole `body-lexical` provenance | score exactly +0.25 | exact bound |
| body phrase count/frequency | attached `lexicalFrequency` | exact lookup of the sole canonical phrase key, or zero after stop stripping | signature phrase-count band (`0` / below `2` / `2+`); raw count orders candidates after rounded score and before id; no score term | exact envelope |
| `directBodyOccurrenceCount` | `directBodyOccurrenceCount(query, document)` | exact unique direct-body occurrence count for the supported candidate | signature band `0` absent, `1` single, `2+` repeated; no score term; not a `compareBoundCandidates()` key | exact envelope |
| `titleTokenCount` | non-stop title count | irrelevant in the supported non-exactish signature | conditional signature scalar; no score | no bound needed |
| expansion/canonical key | configured expansion title evidence | supported path rejects configured-concept occupancy | signature bit / up to +2.1 | otherwise evaluate |
| `retrievalScore` | normalized retriever score × configured weight | supported only when `retrievalScoreWeight === 0` | additive score | nonzero weight evaluates |
| relationship fields | selected edge | supported candidate initially direct with strength 0 | signature relevance/class; +0 | active relationship targets evaluate/fallback |
| `directClass` / `relevanceKind` | all evidence above | exactly `weak` / `direct` for supported candidates | signature fields | exact bound |

## Supported exact envelope

Feature block pruning bounds a retrieved candidate only when all of these are proven:

- exact compiled indexed retriever and a valid pruning extension
- builtin ranking and non-diagnostic result path
- `retrievalScoreWeight === 0`
- one unrepaired, non-number, non-configured-concept query token; longer tokens must have no exact title-token typo evidence
- no dotted/version or inferred prefix-completion state
- exact rechecked provenance is only `body-lexical`
- the first title token cannot produce `shortLiteralLeadMatch`
- no pre-existing relationship on the hit

For such a candidate, `exactBodyOnlySingleTokenBound()` records this partial feature state. `constraintSignature()` reads the unset fields as absent:

```text
exactTitleMatch = exactTitleTokenMatch = typedSurfaceTitleMatch = 0
queryCoverage = titleCoverage = titlePrefixQuality = 0
configured / version / short-lead / dotted / canonical-key / contextual = absent
recall bits = 0
bodyLexicalMatch = 1
lexicalConceptCoverage = 1
coverageConceptCount = 1
queryTokenCount = 1
directClass = weak
relevanceKind = direct
relationshipStrength = retrievalScore = 0
bodyPhraseCount = exact attached-frequency lookup (often 0)
directBodyOccurrenceCount = directBodyOccurrenceCount(query, document)
rounded score = 0.250000
```

`coverageConceptCount` is `1`, so the multi-concept `bodyLexicalMatch` and `lexicalConceptCoverage` bands stay out of the signature. `titleTokenCount` and `contextualPrefixQuality` enter the signature only for exactish or contextual hits, which this class is not. `bodyPhraseCount` contributes `phraseCountBand` (`0`, positive and below `2`, or `2+`). `directBodyOccurrenceCount` contributes `directBodyOccurrenceBand` (`0` absent, `1` single, `2+` repeated). Neither count is a score term. Only `bodyPhraseCount` is a `compareBoundCandidates()` key.

The reachable signature envelope for a block is the exact set of those signatures among its supported candidates, including both bands. Inside one signature, order is still rounded score, then raw `bodyPhraseCount`, then id, so a higher raw phrase count inside the repeated band can outrank a lower count with an earlier id. Any unsupported candidate is outside this envelope and is fully evaluated; it can introduce any signature without being hidden by the bound.

## Exact prune predicate

For each exact signature `S` reachable among the bounded candidates in a document block, take the best incoming candidate under `compareBoundCandidates()` and the worst retained candidate of `S`:

1. If fewer than `representativeDepth` members of `S` are retained, inspect the bounded candidates.
2. If the best incoming candidate sorts ahead of that worst retained candidate, inspect them. A higher rounded score does this. An equal score with a higher `bodyPhraseCount` does this, including when the incoming document id is later. An equal score and equal phrase count with a smaller id does this.
3. Otherwise `compareBoundCandidates(bestIncoming, worstRetained) >= 0` and the bounded candidates of `S` cannot enter its required stream. Equality does not displace the worst retained member.

The block's bounded subset may be skipped only when this holds for every reachable bounded signature. Unsupported documents in the same block are still evaluated.

Document ordinals follow sorted ids, so a later block often loses an equal score and equal phrase count because its ids are greater. A later id with a higher `bodyPhraseCount` still wins that equal-score comparison. The runtime applies `compareBoundCandidates()`; it does not skip from traversal order alone.

## Multi-term and prefix strategy

Feature block pruning does not prune multi-term, prefix-completed, contextual-prefix, morphology-sensitive, typo-sensitive, configured-concept, version, or dotted queries. Those cases can combine evidence from several posting lists and create coverage, adjacency, or previously unseen stronger signatures. They remain exhaustive.

This fail-closed rule also means there is no term-range cap or approximate prefix truncation. Exact prefix expansion remains unchanged.

Future posting-block skipping must operate on a merged query-level document-ordinal view (or an equivalently conservative cross-list envelope), not independently on one term posting list.

## Relationship policy

- `all-strong`: exhaustive.
- `top1-strong` / `top-n-strong`: bounded candidates are proven weak and cannot be primaries. The engine first evaluates all unbounded candidates and selects the exact primary stream.
- If any selected primary owns relationship edges, feature block pruning falls back to exhaustive feature evaluation. This preserves existing-target membership, weak-to-related reclassification, missing-neighbor addition, and related global ranks.
- If no selected primary has edges, relationship expansion cannot observe omitted bounded candidates and pruning is allowed.

This conservative first implementation does not attempt lazy materialization of relationship targets.

## Artifact extension

The integrity-covered extension namespace of a `search-lexical-index` artifact with schema version 1 contains:

```json
{
  "exact-pruning-block-boundaries": {
    "revision": 1,
    "unit": "document-ordinal",
    "blockSize": 128,
    "boundaries": [0, 128, 256]
  }
}
```

The final boundary is the document count. Known-extension corruption, gaps, overlap, invalid sizes, or unsupported revisions reject under the canonical name or its legacy alias. Unknown unrelated extension keys retain the existing additive behavior. An older `search-lexical-index` artifact with schema version 1 that omits the block-boundaries extension loads and runs exhaustive compiled evaluation for feature block pruning.

0.8.0 writes `exact-pruning-block-boundaries` and `exact-pruning-body-term-masks`. It also reads the explicit legacy aliases `exact-pruning-v1` and `exact-pruning-v2`. Each family is resolved independently, so one family may use the canonical name while the other still uses its legacy alias. Both spellings of the same family are rejected, including when the values match. The extension identifier is not the payload revision, not `LEXICAL_INDEX_VERSION`, and not the package release. Both payload revisions stay 1, and the lexical artifact schema stays version 1. Integrity is checked on the stored bytes before a legacy alias is resolved. The loaded artifact keeps those original bytes and the fingerprint that matches them. Package versions before 0.8.0 are not guaranteed to read the names 0.8.0 writes.

## Fallback conditions

Pruning is disabled for:

- public `searchDetailed()` exact diagnostics, or explicit exhaustive mode. Ordinary `search()` / `searchAsync()` with `explain: true` stays eligible
- old artifacts without the extension
- full-scan, legacy/unknown/custom retrievers, or custom constraints
- nonzero retrieval-score ranking weight
- unsupported query/evidence combinations
- `all-strong`
- active relationship expansion
- any malformed or uncertain bound state

Failing to prove eligibility is not an error; it means exhaustive compiled evaluation. Malformed claimed extension metadata is an artifact error.

## Body posting pruning

<a id="stage-3a-unread-body-block-skipping"></a>

Body posting pruning is shipped. It is additive `exact-pruning-body-term-masks` metadata on the same 128-document ordinal grid as `exact-pruning-block-boundaries`. For each body term whose postings span more than one ordinal block, the compiler stores four uint32 presence words per occupied block. Bit i means document `blockStart+i` contains that term in body. Single-block lists omit masks; queries that need those terms reconstruct presence from the list itself only when it still occupies one block.

Supported `search()` / `searchAsync()` path, including `explain: true`: builtin ranking, compiled indexed retriever, exact multi-token query with ≥2 unrepaired non-number term concepts, `retrievalScoreWeight === 0`, not `all-strong`, exact diagnostics off, pruning mode `auto`. Title postings are always walked. Body k-of-k and (k-1)..2-of-k ordinals are always evaluated so phrase adjacency / `bodyPhraseCount` can mint signatures. After those classes fill the weak representative stream to `representativeDepth`, remaining 1-of-k body-only ordinals are skipped without posting decode, materialization, provenance, or `extractFeatures`.

Skip follows that saturation test. Evaluated non-title documents whose body phrase count is below `REPEATED_BODY_PHRASE_MIN` (`2`) count toward `representativeDepth`. Once that weak stream is full, remaining 1-of-k body-only ordinals stay unread. A class-1 document whose `directBodyOccurrenceCount` is at least that minimum stays evaluated when a retrieved title hit can expand a hybrid neighbor, because a repeated direct body occurrence can outrank a zero-term related neighbor. When no such neighbor can be introduced, those occurrence counts are not read. Within-signature order of the candidates that are evaluated is `compareScoreThenWeakBodyThenId()`, described under [exact representative selection](retrievers.md#exact-representative-selection).

### Fail-closed queries

<a id="stage-3a-fail-closed"></a>

Fail closed means exhaustive compiled retrieval, not an error and not approximate top-K. This subsection is the canonical list; other docs should point here rather than keeping a shorter enumeration.

Metadata:

- omitted `exact-pruning-body-term-masks` (and its legacy alias `exact-pruning-v2`) → exhaustive query path
- claimed malformed or unsupported body-term-masks metadata, under either spelling → load reject
- single-block body lists **omit masks**. The query reconstructs presence by walking that list only while it still occupies one block. If reconstruction shows the list now spans more than one block, body posting pruning fails closed. Single-block-only is not itself a fail-closed class.

Engine and query classes that do not take the skip path:

- `searchDetailed()` / `searchDetailedAsync()` exact diagnostics (`search()` / `searchAsync()` is the supported path, including `explain: true`)
- explicit exhaustive mode
- missing compiled pruning runtime, or a retriever that is not compiled indexed
- nonzero `retrievalScoreWeight`
- `all-strong` relationship expansion
- custom constraint functions
- any query `bodyPostingPruningUnsupportedReason()` rejects: fewer than two unrepaired non-number term concepts; prefix-completion; contextual-completion; repaired / typo / leet / configured token sources; numeric tokens; configured-concept occupancy; topical-recall; alternatives; dotted-spans

Prefix *expansion* (enumerating every matching term) stays exhaustive and is outside this capability. PhrasePrefixQuery on an otherwise supported exact multi-token `search()` is not independently a fail-closed class.

Prefix expansion, classic WAND/BMW, and approximate top-K remain out of scope. Body posting pruning is exact signature-aware unread-block skipping, not a global-threshold WAND or MaxScore walker. Corpus sharding is not the query-scaling plan; see [scaling.md](scaling.md).

### Block counters

<a id="stage-3a-block-counters"></a>

`postingBlocks*` fields count unique **128-document ordinal body-presence blocks** for the query (`exact-pruning-body-term-masks` masks, or synthesized from a still-single-block body list). They do not count title posting chunks, duplicate already-walked arrays, or class-pop masks as if those were physical blocks.

| field | meaning |
| --- | --- |
| `postingBlocksTotal` | unique presence blocks |
| `postingBlocksDecoded` | presence blocks whose **body posting payloads** were walked |
| `postingBlocksClassifiedFromMasks` | presence blocks classified from `exact-pruning-body-term-masks` bits without walking body postings |
| `postingBlocksSkippedUnread` | presence blocks that still contain skipped 1-of-k docs whose body postings were never walked |

Invariant: `postingBlocksTotal = postingBlocksDecoded + postingBlocksClassifiedFromMasks`.

`postingBlocksSkippedUnread` is a subset of `postingBlocksClassifiedFromMasks`. It is **not** added into that sum. One presence block can contain both evaluated conjunction docs (from bits, no body-list walk) and skipped 1-of-k docs.

Duplicate posting-list skipping remains separate:

- `duplicatePostingEntriesAvoided` — posting entries not re-decoded because this query already walked that array
- `postingBlocksSkipped` — legacy name; `ceil(df/128)` of those duplicate arrays. Same value as `duplicatePostingBlocksAvoided`
- `postingBlocksVisited` — `ceil(entries/128)` of posting arrays actually walked this query, including title

Title walks stay on `postingBlocksVisited` / `postingEntriesVisited` and are not added into `postingBlocksDecoded`.

`meta.stage3A`, `meta.stage3AFallbackReason`, and the ranking-evidence counter `stage3AWrites` keep those historical names. They report body posting pruning. Benchmark JSON keys `stage1`, `stage2a`, and `stage2b` likewise stay. `--suite stage1` selects the exact-compiled suite, and `scripts/stage2b-posting-audit.mjs` forwards to `scripts/posting-work-audit.mjs`. There is no diagnostic or benchmark schema migration.

## Duplicate posting-list skipping and the compact runtime

<a id="stage-2b2c-boundary"></a>

Feature block pruning can dramatically reduce full feature and signature work for common body-only floods.

Duplicate posting-list skipping avoids another walk of an identical posting array already visited during the same query. If this query has already decoded a compiled `title` or `body` posting `number[]`, later token, concept, lemma, or contextual lanes that point at that same array are not decoded again. It does not skip a posting list this query has not yet read. Membership and `retrievalSourcesForDocument` provenance stay exhaustive. Default ranking is unchanged because `retrievalScoreWeight` defaults to `0`.

Body posting pruning may skip unread 1-of-k body regions after stronger co-occurrence classes on the shared document-ordinal grid have been evaluated. A block still cannot be dropped merely because a term-local posting envelope looks weak: unseen signatures, phrase and direct-class jumps, and title evidence force evaluation. Multi-term evidence is never proven from “all terms occur somewhere in this 128-doc block”; the skip uses per-document presence bits.

Prefix expansion stays exhaustive. Historical prefix recall failures must not return. Dictionary-range metadata may later accelerate lookup; it must not cap terms.

Nonzero `retrievalScoreWeight` fail-closes to the exhaustive posting walk so BM25 reconstruction stays identical to exhaustive compiled evaluation. Active relationships keep feature block pruning's fail-closed feature policy; duplicate-list skip still returns the full lexical membership set.

Duplicate posting-list skipping has no schema version bump: identical-array skip is query-time identity. Body posting pruning adds the additive `exact-pruning-body-term-masks` extension described above; older artifacts without it remain exhaustive. The compact lexical runtime replaces hydrated Sets, Maps, and token arrays with compact views over the same `search-lexical-index` schema version 1 bytes; it does not change the duplicate-list proof.

## Ranking evidence vs retrieval pruning (0.6.5)

Feature block pruning, duplicate posting-list skipping, and body posting pruning omit retrieval or FeatureVector work that cannot change exact representatives. 0.6.5 ranking-evidence fusion is a separate path, not another pruning capability. On eligible ordinary `search()` / `searchAsync()`, the compiled retriever records exact ranking facts during the posting and mask walk already required by retrieval, then finalizes packed numeric columns for the existing builtin selector and constraint ranker.

Properties:

- same public ranking and result semantics
- no second high-DF posting traversal
- default hybrid uses this path
- packed ranking evidence stays off for `searchDetailed()`, `explain: true`, exhaustive diagnostics, and complete-interpretation collection, so those calls use FeatureVectors. `explain: true` on ordinary `search()` / `searchAsync()` remains eligible for feature block pruning and body posting pruning. Public `searchDetailed()` and explicit exhaustive mode turn those capabilities off
- unsupported query/retriever/constraint shapes fail closed to that FeatureVector path without quality loss
- no public API, artifact extension, or retriever option

Retrieval pruning and ranking-evidence production can both apply on the same ordinary query. Body posting pruning alone is not the 0.6.5 production architecture. See [scaling.md](scaling.md) and [compact-runtime.md](compact-runtime.md).
