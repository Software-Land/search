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
{ id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks.", metadata?: { ... } }
```

| Rule | Behavior |
| --- | --- |
| `id` | Required, non-empty string after `String()` + trim |
| `title` / `body` | Optional; missing/null become `""`; non-strings are coerced with `String()` |
| `metadata` | Stored on a shallow copy; **not searchable** |
| Duplicate `id` | Last document wins; one analyzed record remains |
| Field concat | Caller responsibility. Core does not prepend category names |
| Mutation after `index()` | Title/body are copied as strings. Do not rely on mutating the original object |

`index(documents)` **replaces** the previous index (rebuild). There is no append/incremental API. Indexing is async at the function signature but the work is currently synchronous inside. Cancellation of `index()` is not supported.

Invalid documents throw `InvalidDocumentError` (missing id, non-object entries, non-array `documents`). Searching before `index()` throws `IndexStateError`.
