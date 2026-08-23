# Relationships

Core consumes a versioned `search-v2-relationships` artifact. It does not embed documents.

## Strategies (application policy, not a different engine)

| strategy | `results` | `related` |
| --- | --- | --- |
| **hybrid** (default) | Strong/moderate directs stay protected; strong relationship-derived hits may outrank weak body-only directs | Relationship-derived channel (may overlap `results`) |
| **mixed** | Related may enter the same list but stay behind title-ish directs | Same channel |
| **separate** | Direct / direct-primary only | Related rail |
| **none** | No expansion | `[]` |

Article/documentation search often wants **hybrid** (one list). Settings-like destination search often wants **separate** (a related rail, not mixed into the destination list).

Expansion runs **after** every legitimate lexical match has been featured and strong primaries have been selected. Neighbors are never indexed as lexical query terms. Default exact indexed retrieval does not truncate primaries by `candidateLimit`; policy-specific representative selection for `top1-strong` / `top-n-strong` is exact, while `all-strong` retains every eligible primary.

## Types

The compiler decides what is in the runtime artifact. Search Core expands **every edge present**. Default `search-relationships` runtime output includes:

- search-eligible: `semantic`, `editorial`, `manually-related`
- stored/structural (full artifact only): `same-category`, `prerequisite`, `supersedes`

## Example

```js
const engine = SearchEngine.create({
  plugins: [morphology()],
  relationshipStrategy: "separate",
  relationships: {
    format: "search-v2-relationships",
    version: 1,
    relationships: {
      bluetooth: [{ target: "connected-devices", type: "editorial", strength: 1, provenance: "manual" }],
    },
  },
});
await engine.index([
  { id: "bluetooth", title: "Bluetooth", body: "Wireless accessories." },
  { id: "connected-devices", title: "Connected devices", body: "Bluetooth, NFC, USB." },
]);
const { results, related } = engine.searchDetailed("bluetooth", { relatedLimit: 5 });
// results[0].title === "Bluetooth"
// related[0].title === "Connected devices"
```
