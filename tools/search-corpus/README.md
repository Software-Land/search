# search-corpus (optional build-time compiler)

Offline compiler that mines **lexical / domain intelligence** from a portable corpus, then compiles **only trusted** Search Core artifacts.

```text
corpus JSON
  → analyze (miners + evidence)
  → generated candidates + stable IDs
  → durable review-decisions.json   ← source-controlled; never overwritten
  → compile
  → equivalences.json + synonyms.json (trusted only)
```

Generated evidence is disposable. Reviewed decisions are durable. Runtime receives only trusted compiled truth.

This is **not** `search-semantic`. Equivalence ≠ synonym ≠ relatedness.

Search Core must never import this package.

## Layout

```text
tools/search-corpus/
  build.mjs
  index.js
  config/decisions.example.json
  lib/
    ids.js          stable candidate identities
    decisions.js    load/validate review file
    lifecycle.js    AUTO_ACCEPTED / REVIEW_PENDING / HUMAN_* / CONFLICT / ORPHANED
    pipeline.js     analyzeCorpus + compileCorpus
    ...
```

## OSS workflow

```bash
node tools/search-corpus/build.mjs analyze --input corpus.json --output dir
# inspect dir/inspection.json pending[] and delta.json
# edit config/decisions.example.json (or your decisions file)

node tools/search-corpus/build.mjs compile --input corpus.json --output dir \
  --decisions path/to/decisions.json

node tools/search-corpus/build.mjs review --pending --output dir
```

`build` (default) wraps analyze+compile. Re-running analyze **does not** modify the decisions file. Decisions apply by stable candidate ID.

## Decision file

```json
{
  "format": "search-corpus-decisions",
  "version": 1,
  "equivalences": [
    {
      "decision": "accept",
      "key": "api",
      "expansion": ["application", "programming", "interface"]
    },
    { "decision": "reject", "key": "io" }
  ],
  "synonyms": [
    {
      "decision": "accept",
      "terms": ["auth", "authentication"],
      "relation": "alias"
    }
  ]
}
```

`accept` / `reject` only. Absence means unresolved. Manual additions (`manual: true`) compile even with no mined candidate.

Human truth outranks inference. Ambiguous trusted acronyms are omitted from runtime until the conflict is resolved. Malformed files fail compile.

## Lifecycle

| state | runtime? |
| --- | --- |
| AUTO_ACCEPTED | yes |
| HUMAN_ACCEPTED | yes |
| REVIEW_PENDING | no |
| HUMAN_REJECTED | no |
| CONFLICT | no |
| ORPHANED_DECISION | no (unless accept is complete → still compiles) |

Compiler `recommendation: likely-equivalence` is not a decision.

## Review queue quality

`REVIEW_PENDING` is ranked for **human attention only**. Priority never becomes runtime confidence and never changes lifecycle.

```text
HIGH     exact initialism + explicit definition or title/body evidence
MEDIUM   plausible alias / multi-document expansion
LOW      weak remainder, morphology-adjacent, redundant-to-accepted
```

Short tokens (length 1–3) are **not** blanket-rejected. They need stronger evidence to stay in the queue: explicit definition, title+body co-occurrence, title-key with body expansion, or independent expansion DF≥2 plus a title key. Junk 2-letter title ngrams are dropped from review, not auto-accepted.

Overlapping expansions of the same key form an `equivalence-family`. Only the canonical pending member is listed by `review --pending`. Stable candidate IDs are unchanged.

```bash
node tools/search-corpus/build.mjs review --pending --output dir
node tools/search-corpus/build.mjs review --pending --type equivalence --priority high --output dir
```

Each pending row includes a copyable `decisionSkeleton`. Paste it into the decisions file; do not edit runtime artifacts by hand.

## Automatic equivalence acceptance

Automatic acceptance requires explicit definition + exact initials + repeated/title-backed + unambiguous. Do not loosen for recall.

## Synonyms

Candidates only (`alias` / `synonym` / `surface-variant`). Nothing auto-compiles. Inflections Core already handles are not proposed. Relatedness (TLS/VPN, authentication/authorization) is blocked.

## Future extensions

Phrase→initialism invention is **not** a deterministic compiler path. Digit-prefixed compounds (`200FPS`) count as acronym evidence only when that suffix is independently observed as a standalone acronym surface in the same document. If an attested phrase has no mined acronym, or an acronym has no mined expansion, bounded `discover-equivalences` / `propose-expansion` may propose the missing side for review. Remaining editorial coverage still belongs in the decisions file.

Not in scope here: automatic synonym acceptance, editorial relationship mining, category inference, on-device model weights.
