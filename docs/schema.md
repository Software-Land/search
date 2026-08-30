# Schema and documents

Stable field roles are **title**, **body**, and optional **summary**.

```js
{
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
}
```

An optional third text field uses role `"summary"` (not `"description"`). Callers that omit it keep the two-field contract.

`summary` is **not** a third ordinary lexical posting field. Unigram / token / lemma candidate generation still uses **title** and **body** only. Summary is consumed for:

- positional PhraseQuery and PhrasePrefixQuery (contiguous originalSurface in the summary token stream)
- configured-concept field evidence (`configuredConceptFieldEvidence.summary`)
- typed-phrase ranking features (`summaryPhraseFrequency`, `exactTitleOrSummaryPhrase`)
- complete-interpretation authored (title∪summary) prefix membership

A term that occurs only as a summary unigram, with no title/body lexical hit and no ≥2-token exact phrase, is not a retrieval candidate.

```js
{
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
}
```

If `schema` is omitted, the default title/body schema is used. If `schema` is provided, it must be a plain object with at least one `{ type: "text" }` field. `role` must be `"title"`, `"body"`, or `"summary"` when present.

## Documents

```js
{
  id: "wifi",
  title: "Wi-Fi",
  summary: "Connect to wireless networks.",
  body: "Full article text.",
  metadata?: { ... },
  lexicalFrequency?: { "connect wireless": 2 }
}
```

`summary` is optional. Documents without it, and schemas without a summary role, index as title/body only. Core does not concatenate summary into body.

| Rule | Behavior |
| --- | --- |
| `id` | Required, non-empty string after `String()` + trim |
| `title` / `body` | Optional; missing/null become `""`; non-strings are coerced with `String()` |
| `metadata` | Stored on a shallow copy; **not searchable** |
| `lexicalFrequency` | Optional attached phrase-frequency map, normally produced by `attachLexicalFrequency()`; not serialized into the lexical index |
| Duplicate `id` | Last document wins; one analyzed record remains |
| Field concat | Caller responsibility. Core does not prepend category names |
| Mutation after `index()` | Title/body are copied as strings. Do not rely on mutating the original object |

When a supplied `search-v2-lexical-index` is used, callers must still pass documents whose canonical ids, raw title/body strings, and attached `lexicalFrequency` maps match its corpus fingerprint. The v1 fingerprint is `(id, title, body, lexicalFrequency)` and does not include `summary`: summary is not stored in the artifact. Load hydrates summary from the caller documents. After that artifact has been consumed, re-index reuse also checks a separate hydration fingerprint so a summary-only edit cannot keep stale search-relevant state. Title/body-only schemas are unchanged. The body is validated even though hydrated query-time title/body state comes from positional postings.

There is no append/incremental API. Artifact-omitted `index(documents)` rebuilds from replacement input. After a supplied artifact has been consumed, the identical validated corpus reuses the hydrated state and incompatible replacement input rejects. Indexing is async at the function signature but the work is currently synchronous inside. Cancellation of `index()` is not supported.

Invalid documents throw `InvalidDocumentError` (missing id, non-object entries, non-array `documents`). Searching before `index()` throws `IndexStateError`.
