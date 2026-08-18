# Browser Worker

Optional. Core does not import `Worker` or `window`.

```js
import { createSearchClient, searchWorkerUrl } from "software-land-search/browser";

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

`createLatestWinsSession` and `createWorkerRuntime` exist for tests and custom hosts. Prefer `createSearchClient` in apps.
