# Compact lexical runtime (Stage 2C)

Stage 2C is a representation optimization. It does not change retrieval, features, constraints, scores, representatives, relationships, ranks, explanations, or `search-v2-lexical-index` v1 bytes.

```text
packed immutable lexical representation
+ lightweight document/display metadata
+ query-time views/accessors
```

rather than reconstructing token arrays, lemma arrays, Sets, and position Maps for every document at load.

Exactness remains:

```text
compact runtime
== current hydrated runtime
== Stage-2B
== Stage-2A
== Stage-1 exhaustive compiled
== frozen public quality
```

The full-scan/reference path may keep fat `IndexedDocument` objects. Indexed and adaptive omitted-artifact `index()` compile into the same compact runtime.

## Benchmark methodology

Absolute milliseconds are not a semantic signal. Hardware, OS noise, and single-shot `meta.totalMs` explain historical variation such as a Stage-1 mixed high-DF sample moving ~169 ms → ~126 ms without any ranking change.

Node measurements that claim timing now:

- warm up
- run several iterations in the same process
- report p50, and p90 where useful
- compare modes from that same run

CI must not treat latency as a contract. Store harness output separately from tests:

```bash
node --expose-gc scripts/heap-attribution.mjs --n 25000
node --expose-gc scripts/compact-runtime-bench.mjs --sizes 1000,5000,10000,25000
node --expose-gc scripts/budget-pressure.mjs --suite stage1 --sizes 1000,5000,10000,25000
```

## Heap attribution (approximate)

V8 `heapUsed` deltas after `gc()` are ownership estimates, not retained-size proofs. Build structures one at a time.

On mixed N=25k the Stage-2B object runtime was dominated by per-document JavaScript graphs, not the packed artifact:

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
| `firstToken` | short-literal, Stage 2A | cheap | no — surface fact | yes | n/a | n/a | n/a | n/a | stored |
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

- **A. Hydrated objects** — Stage-2B baseline; ~1 GB mixed 25k heap.
- **B. Lazy `IndexedDocumentView`** — packed data, accessors decode query needs.
- **C. Query-local evidence view** — skip document objects; map query+ordinal → `FeatureVector`.
- **D. Hybrid** — tiny per-doc metadata plus packed token/position streams.

Chosen: **D + B**. `CompactIndexedDocument` duck-types `IndexedDocument` so the frozen feature oracle and retrieve/feature code keep working without a second extractor. Token storage is global `Uint32Array`s with per-document offsets and an interned dictionary. Lemma arrays are not stored; `lemmaOf[surfaceId]` is applied at access. Permanent per-document `Set`/`Map` graphs are not allocated. Query-local Sets of a few terms are preferred over 25k permanent Sets.

A pure C rewrite would be a smaller semantic abstraction eventually, but it would fork the frozen oracle. Stage 2C stops at a compact document view.

Term ids are `Uint32Array`, not `Uint16Array`, so vocabulary size is not capped at 16 bits.

Stage 2B still sees compiled posting `number[]` identity, so the existing `WeakSet` skip remains the semantic equivalent of “walk each unique logical posting slice once per query.”

## Artifact format

Current `search-v2-lexical-index` v1 bytes hydrate the compact runtime. No version bump. No required `data.extensions` for Stage 2C. Old v1 artifacts stay exact.

## Fallback and full-scan

Omitted artifact, indexed/adaptive: analyze once, compile, hydrate the compact runtime. Initialization may be slower; query behavior uses the compact path.

`retriever: "full-scan"` keeps fat objects so the reference path stays simple.

## Public API

Typed arrays, term ordinals, offsets, packed stores, and document views are not exported from the root package.
