# Browser Worker

Optional. Core does not import `Worker` or `window`.

```js
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const client = createSearchClient({
  workerUrl: searchWorkerUrl(),
  onResult({ query, result, generation }) { /* render */ },
  onClear({ generation, query }) {},
  onError({ generation, query, error }) {},
});

await client.init({ documents, schema, dictionaryEntries, relationships, retriever: "adaptive" });
client.setQuery("bluetooth");
client.setQuery("");   // cancel, drop pending, clear
client.dispose();
```

`searchWorkerUrl()` is resolved from this package so consumers do not construct a Worker URL against their own module. Omitting `workerUrl` uses the same default.

## Latest-wins

- at most one running search
- at most one latest pending
- a new query replaces pending and cancels stale running
- generation / request-id guard
- empty input cancels and clears
- teardown invalidates outstanding work

Plain `postMessage`. Protocol v1 messages: `init`, `search`, `cancel`, `dispose`, `ready`, `result`, `error`, `aborted`. Payloads must be structured-clone-safe. Explanations are JSON-serializable. Stale responses must not publish.

`init` accepts the same optional `lexicalIndex` as `SearchEngine.create`. Omission builds the exact fallback index during initialization; an invalid supplied artifact replies with `error`. When compiling with custom lemmas, pass the same map to Worker `englishOptions` so its deterministic analyzer identity matches. After `ready`, the Worker has released its envelope reference and retained compact runtime state, so the page may release its own artifact reference.

Worker searches use the normal exact representative path, including fail-closed Stage-2A feature-block pruning when its proof applies, and forward result/related rows plus a high-level timing/count meta subset (`totalMs`, `retrieveMs`, `featureMs`, `selectionMs`, `rankMs`, `candidateCount`, `matchCount`, `relatedCount`, `relationshipStrategy`). Stage-2 posting/block/pruning counters stay on `searchDetailed()` / `lastSearchMeta` and an internal Worker diagnostics switch; they are not part of the public Worker protocol. `explain: true` still preserves each returned row's explanation, exact successor, and constraint metadata.

`createLatestWinsSession` and `createWorkerRuntime` exist for tests and custom hosts. Prefer `createSearchClient` in apps.
