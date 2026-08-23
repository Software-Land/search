# Schema and documents

Stable field roles are **title** and **body** only.

```js
{
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
}
```

If `schema` is omitted, that default is used. If `schema` is provided, it must be a plain object with at least one `{ type: "text" }` field. `role` must be `"title"` or `"body"` when present. Other roles are not a supported contract; extra text fields without those roles are not independently ranked.

## Documents

```js
{
  id: "wifi",
  title: "Wi-Fi",
  body: "Connect to wireless networks.",
  metadata?: { ... },
  lexicalFrequency?: { "connect wireless": 2 }
}
```

| Rule | Behavior |
| --- | --- |
| `id` | Required, non-empty string after `String()` + trim |
| `title` / `body` | Optional; missing/null become `""`; non-strings are coerced with `String()` |
| `metadata` | Stored on a shallow copy; **not searchable** |
| `lexicalFrequency` | Optional attached phrase-frequency map, normally produced by `attachLexicalFrequency()`; not serialized into the lexical index |
| Duplicate `id` | Last document wins; one analyzed record remains |
| Field concat | Caller responsibility. Core does not prepend category names |
| Mutation after `index()` | Title/body are copied as strings. Do not rely on mutating the original object |

When a supplied `search-v2-lexical-index` is used, callers must still pass documents whose canonical ids, raw title/body strings, and attached `lexicalFrequency` maps match its corpus fingerprint. The body is validated even though hydrated query-time state comes from positional postings.

There is no append/incremental API. Artifact-omitted `index(documents)` rebuilds from replacement input. After a supplied artifact has been consumed, the identical validated corpus reuses the hydrated state and incompatible replacement input rejects. Indexing is async at the function signature but the work is currently synchronous inside. Cancellation of `index()` is not supported.

Invalid documents throw `InvalidDocumentError` (missing id, non-object entries, non-array `documents`). Searching before `index()` throws `IndexStateError`.
