# search-relationships (build-time)

Typed **domain/editorial** relationship compiler and merger. Lexical miners stay frozen. Search Core stays frozen.

```text
search-semantic  → semantic artifact
domain decisions → editorial / prerequisite / same-category / manually-related
        ↓
search-relationships merge
        ↓
search-v2-relationships v1
```

`search-semantic` does not import this package. This package does not import `search-corpus` miners or Search Core.

Generated output never overwrites the decisions file.

Conflicting `accept` and `reject` for the same relationship id fail compile. Missing endpoints become `ORPHANED_DECISION` and are omitted from runtime. Content-link mining is optional (`--no-mine`); candidates stay `REVIEW_PENDING` until accepted. Co-occurrence is not a miner. Production editorial truth is the decisions file.

## Taxonomy

| type | direction | default search/related |
| --- | --- | --- |
| `semantic` | as in source artifact | yes |
| `editorial` | symmetric unless `directional: true` | yes |
| `manually-related` | symmetric unless `directional: true` | yes |
| `same-category` | symmetric | stored only |
| `prerequisite` | source → target | stored only |
| `supersedes` | source → target | stored only |

Custom types are added by extending `RELATIONSHIP_TYPES` — unknown types fail compile.

Strength for human/editorial edges is discrete `1` (explicit), not a fake cosine. Semantic edges keep builder scores.

## Decisions

```json
{
  "format": "search-relationships-decisions",
  "version": 1,
  "relationships": [
    {
      "source": "/tls-1.2-vulnerability/",
      "target": "/what-is-vpn/",
      "type": "editorial",
      "decision": "accept",
      "note": "security neighborhood"
    }
  ]
}
```

Source/target may be corpus ids or paths. Runtime edges use corpus ids. Missing endpoints become `ORPHANED_DECISION`, not silent retargeting. `accept` + `reject` on the same id fails compile.

## CLI

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json \
  --decisions tools/search-relationships/config/decisions.example.json \
  --semantic relationships-from-builder.json \
  --output dir
```

`--no-mine` skips content-link candidates. Candidates are `REVIEW_PENDING` until accepted. Co-occurrence is not a miner.

Default runtime artifact includes `semantic`, `editorial`, and `manually-related`. Structural types remain in `relationships-full.json`.
