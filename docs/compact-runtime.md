# Compact lexical runtime

<a id="compact-lexical-runtime-stage-2c"></a>

The compact lexical runtime is a representation optimization. It does not change retrieval, features, constraints, scores, representatives, relationships, ranks, explanations, or the bytes of a `search-lexical-index` artifact with schema version 1.

```text
packed immutable lexical representation
+ lightweight document/display metadata
+ query-time views/accessors
```

rather than reconstructing token arrays, lemma arrays, Sets, and position Maps for every document at load.

Exactness remains:

```text
compact lexical runtime
== hydrated runtime
== duplicate posting-list skipping
== feature block pruning
== exhaustive compiled evaluation
== frozen public quality
```

The full-scan/reference path may keep fat `IndexedDocument` objects. Indexed and adaptive omitted-artifact `index()` compile into the same compact runtime.

## Benchmark methodology

Absolute milliseconds are not a semantic signal. Hardware, OS noise, and single-shot `meta.totalMs` explain historical variation such as an earlier exact compiled retrieval sample moving ~169 ms → ~126 ms without any ranking change.

Node measurements that claim timing now:

- warm up
- run several iterations in the same process
- report p50, and p90 where useful
- compare modes from that same run

CI must not treat latency as a contract. Store harness output separately from tests:

```bash
node --expose-gc scripts/heap-attribution.mjs --n 25000
node --expose-gc scripts/compact-runtime-bench.mjs --sizes 1000,5000,10000,25000
node --expose-gc scripts/budget-pressure.mjs --suite exact-compiled --sizes 1000,5000,10000,25000
```

## Heap attribution (approximate)

V8 `heapUsed` deltas after `gc()` are ownership estimates, not retained-size proofs. Build structures one at a time.

On mixed N=25k the earlier hydrated-object runtime was dominated by per-document JavaScript graphs, not the packed artifact:

1. Per-document token/lemma string arrays plus `Set`/`Map` objects (`titleTokens`, `bodyTokens`, four Sets, two position Maps)
2. Compiled posting `number[]` rows plus `bySurface` / `byLemma` lookup
3. Display/metadata strings (`id`, `title`, `normalizedTitle`) and attached `lexicalFrequency` maps

Typed token-id arrays and interned dictionary strings are small relative to those object graphs. `lexicalFrequency` remains separately owned and is not merged into the lexical index.

## IndexedDocument consumer audit

| field | consumers | query-time | from packed postings? | from metadata? | random access | iteration | Set semantics | positions | lazy? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `titleTokens` | features, retrieve, exact pruning, compile | per evaluated doc | yes | no | yes | yes | no | implicit | yes |
| `bodyTokens` | features, retrieve, compile | per evaluated match | yes | no | yes | yes | no | implicit | yes |
| `titleLemmas` | features, retrieve, frozen feature oracle | per evaluated doc | dictionary `surface→lemma` | no | yes | yes | no | implicit | yes |
| `bodyLemmas` | features, retrieve | per evaluated match | dictionary | no | yes | yes | no | implicit | yes |
| `titleTokenSet` | features, retrieve | `.has` of query forms | membership scan / postings | no | no | no | `.has` only | no | yes |
| `bodyTokenSet` | retrieve provenance | `.has` of query forms | membership scan / postings | no | no | no | `.has` only | no | yes |
| `titleLemmaSet` | features, retrieve | `.has` | lemma ids | no | no | no | `.has` only | no | yes |
| `bodyLemmaSet` | retrieve | `.has` | lemma ids | no | no | no | `.has` only | no | yes |
| `nonStopTitle` | features (`titleTokenCount`, tightness) | per evaluated doc | title ids minus stop list | no | yes | yes | no | no | yes |
| `firstToken` | short-literal, feature block pruning | cheap | no — surface fact | yes | n/a | n/a | n/a | n/a | stored |
| `normalizedTitle` | exact title, prefix | cheap | reconstructable | stored to avoid join | n/a | n/a | n/a | n/a | stored |
| `independentTitleTokens` | typed surface / prefix quality | per evaluated doc | title ids minus dotted indexes | dotted metadata | yes | yes | no | no | yes |
| `independentTitleTokenSet` | independent token checks | `.has` | same | dotted metadata | no | no | `.has` | no | yes |
| `dottedSpanComponentIndexes` | versionForms, features | `.has` / iterate | no — build-time | yes | no | rare | `.has` | no | packed offsets |
| `versionCompactForms` | version matching | small arrays | no — surface fact | yes | n/a | yes | n/a | n/a | stored |
| `dottedSpans` | version matching | small arrays | no — surface fact | yes | n/a | yes | n/a | n/a | stored |
| `bodyTokenPositions` | phrase adjacency on long bodies | optional | posting positions / token ids | no | by term | no | no | yes | lazy scan |
| `bodyLemmaPositions` | lemma phrases | optional | lemma ids | no | by term | no | no | yes | lazy scan |
| `lexicalFrequency` | body-phrase count | attached maps | no | external | by ngram | n/a | n/a | n/a | unchanged |
| raw/title display | public hits | always | no | caller documents | n/a | n/a | n/a | n/a | stored title; body omitted |

Index-level `titleTokenSet` and `surfaceVocabulary` stay real `Set`s (query analysis lexicon). They are vocabulary-sized, not per-document.

## Runtime abstraction

Compared:

- **A. Hydrated objects** — pre-compact baseline; ~1 GB mixed 25k heap.
- **B. Lazy `IndexedDocumentView`** — packed data, accessors decode query needs.
- **C. Query-local evidence view** — skip document objects; map query+ordinal → `FeatureVector`.
- **D. Hybrid** — tiny per-doc metadata plus packed token/position streams.

Chosen: **D + B**. `CompactIndexedDocument` duck-types `IndexedDocument` so the frozen feature oracle and retrieve/feature code keep working without a second extractor. Token storage is global `Uint32Array`s with per-document offsets and an interned dictionary. Lemma arrays are not stored; `lemmaOf[surfaceId]` is applied at access. Permanent per-document `Set`/`Map` graphs are not allocated. Query-local Sets of a few terms are preferred over 25k permanent Sets.

A pure C rewrite would be a smaller semantic abstraction eventually, but it would fork the frozen oracle. The compact lexical runtime stops at a compact document view.

Term ids are `Uint32Array`, not `Uint16Array`, so vocabulary size is not capped at 16 bits.

Duplicate posting-list skipping still sees compiled posting `number[]` identity, so the existing `WeakSet` skip remains “walk each unique logical posting slice once per query.” It does not skip a list this query has not read.

## Artifact format

Bytes of a `search-lexical-index` artifact with schema version 1 hydrate the compact runtime. The schema version stays 1. The compact lexical runtime requires no `data.extensions`. Older artifacts with that schema version stay exact.

## Fallback and full-scan

Omitted artifact, indexed/adaptive: analyze once, compile, hydrate the compact runtime. Initialization may be slower; query behavior uses the compact path.

`retriever: "full-scan"` keeps fat objects so the reference path stays simple.

## Public API

Typed arrays, term ordinals, offsets, packed stores, and document views are not exported from the root package.

## Packed ranking representation (0.6.5)

The compact lexical runtime is the document view. Eligible ordinary `search()` / `searchAsync()` additionally keep compact ordinal-aligned ranking-evidence state: generation/slot session memory plus packed numeric columns used as ranking accessors. Those views are not public types and are not a lexical-artifact extension. Byte layouts are implementation details, not a package contract. `searchDetailed()` and ineligible shapes still construct FeatureVectors. See [scaling.md](scaling.md) and [exact-pruning.md](exact-pruning.md).

## Phrase adjacency fast path

### Exact `phraseAdjacency` semantics

Return values are `1` (title), `0.5` (body), or `0`. Title is checked first; a title hit does not also score the body.

Query sequences are stop-stripped `nonStopNorm` / `nonStopLemma` from analyzed tokens (`t.normalized` and `t.lemma || t.normalized`). Tokens in `DEFAULT_STOP` are dropped unless the whole query has two or fewer tokens; if that filter empties the sequence, the original tokens are kept. Queries with fewer than two remaining tokens return `0`. Prefix completion is whatever analysis already stored on those tokens; this feature does not apply a second completion pass.

A window of length `m` matches when every aligned pair satisfies `tokenAdjacencyMatch`:

- if either side is all digits, equality is required
- otherwise `tt === qt || tt.startsWith(qt)` (no `allowPrefixMatch` min-length)

Repeated query tokens and overlapping field windows are ordinary sliding windows; the first hit wins. Dictionary concepts, compiled `bodyPhraseCount` / lexical-frequency n-grams, and retrieval provenance are separate features.

Surface streams run first. Lemma streams run only when the query surface/lemma sequences differ **or** that field’s surface/lemma sequences differ. Surface precedence is therefore: title surface, title lemma (if needed), body surface, body lemma (if needed).

### Why not posting intersection

Compiled positional postings are term-oriented and cheap to walk by document ordinal, but they cannot reconstruct this feature as exact `t0@p ∧ t1@p+1 ∧ t2@p+2` term-id membership. Prefix-capable non-digit matching would require expanding every query token against the vocabulary, then intersecting those posting unions, then still applying the same window predicate for repeats, digits, and missing terms. A ~60-token packed-id scan is the exact equivalent and does not need a persistent doc→posting offset table.

The compact runtime originally scanned `PackedTokenProxy` bodies and skipped the hydrated-object `Map` start index (`instanceof Map` failed). That was a compact-runtime regression, not an inherent phrase cost.

The compact adapter now applies the shared `tokenAdjacencyMatch` predicate over packed `Uint32Array` token ids and interned strings (`compactAdjacentTokens`). Fat full-scan keeps the object/`Map` adapter. No persistent side index. Query-local work is existing per-search feature state plus a small interned-id `Set` during compact body-concept membership. Title/body concept helpers used by `queryCoverage` follow the same packed-id pattern; they do not change `extractFeatures` output on the FeatureVector path.

Eligible ordinary indexed `search()` / `searchAsync()` rank from compact ordinal-aligned ranking-evidence state (generation/slot session plus packed numeric columns) rather than allocating a FeatureVector per retrieved direct. `searchDetailed()` is exact diagnostics: feature block pruning and body posting pruning do not skip work on that call. Explicit exhaustive mode does not either. `explain: true` disables packed ranking evidence and still leaves both pruning capabilities on their ordinary `search()` gates. Those explained calls, exhaustive mode, and other ineligible `search()` shapes extract features for matches that feature block pruning does not bound-reject and that body posting pruning does not skip as unread 1-of-k body-only. Multi-token and phrase conjunction classes are not feature-block pruned: exact class and constraint-signature membership can depend on body evidence. A later lazy FeatureVector skip was investigated and not shipped; 0.6.5 uses fused ranking evidence instead. See [limitations.md](limitations.md), [exact-pruning.md](exact-pruning.md), and [scaling.md](scaling.md).
