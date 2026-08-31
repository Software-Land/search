# search-relationships (build-time)

Merges a semantic graph with explicit typed domain relationships. Search Core stays frozen.

```text
search-semantic              → semantic artifact
explicit domain relationships → editorial / prerequisite / same-category / manually-related
        ↓
search-relationships merge
        ↓
search-v2-relationships v1
```

`search-semantic` does not import this package. This package does not import `search-corpus` miners or Search Core. It does not mine candidates or run a review queue.

Generated output never overwrites the domain relationships file. Missing type, unknown type, and unresolved source/target refs fail compile.

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

Strength for explicit domain edges is discrete `1` (or `priority` when set), not a fake cosine. Semantic edges keep builder scores.

## Domain relationships

```json
{
  "format": "search-relationships-domain",
  "version": 1,
  "relationships": [
    {
      "source": "/tls-1.2-vulnerability/",
      "target": "/what-is-vpn/",
      "type": "editorial",
      "note": "security neighborhood"
    }
  ]
}
```

Every record asserts that the relationship exists and must include `type`. Source/target may be corpus ids or paths. Runtime edges use corpus ids. Omitted provenance compiles as `"manual"`.

## CLI

From a git checkout. After `npm install @software-land/search`, the same file is `node_modules/@software-land/search/tools/search-relationships/build.mjs`.

```bash
node tools/search-relationships/build.mjs compile \
  --input corpus.json \
  --domain tools/search-relationships/config/domain.example.json \
  --semantic relationships-from-builder.json \
  --output dir
```

Default runtime artifact includes `semantic`, `editorial`, and `manually-related`. Structural types remain in `relationships-full.json`.
