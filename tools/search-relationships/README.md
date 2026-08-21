# search-relationships (build-time)

Typed **domain/editorial** relationship compiler and merger. Search Core stays frozen.

```text
search-semantic  → semantic artifact
explicit decisions → editorial / prerequisite / same-category / manually-related
        ↓
search-relationships merge
        ↓
search-v2-relationships v1
```

`search-semantic` does not import this package. This package does not import `search-corpus` miners or Search Core. It does not mine candidates or run a human-review queue.

Generated output never overwrites the decisions file.

Conflicting `accept` and `reject` for the same relationship id fail compile. Missing endpoints are orphaned and omitted from runtime. Production editorial truth is the decisions file.

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

Strength for explicit editorial edges is discrete `1` (or `priority` when set), not a fake cosine. Semantic edges keep builder scores. Reject of a type, or `type: "*"`, wins at merge.

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

Source/target may be corpus ids or paths. Runtime edges use corpus ids. Missing endpoints are orphaned, not silently retargeted. `accept` + `reject` on the same id fails compile.

## CLI

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json \
  --decisions tools/search-relationships/config/decisions.example.json \
  --semantic relationships-from-builder.json \
  --output dir
```

Default runtime artifact includes `semantic`, `editorial`, and `manually-related`. Structural types remain in `relationships-full.json`.
