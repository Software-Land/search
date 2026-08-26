import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const state = {
  published: [],
  last: null,
  errors: [],
  workerUrl: String(searchWorkerUrl()),
  retriever: null,
  documentCount: null,
};

function recordError(err, extra = {}) {
  const rec = err && typeof err === "object" ? err : {};
  state.errors.push({
    message: String(rec.message || err),
    name: rec.name || extra.kind || "Error",
    ...extra,
  });
}

window.addEventListener("unhandledrejection", (ev) => {
  recordError(ev.reason, { kind: "unhandledrejection" });
});
window.addEventListener("error", (ev) => {
  recordError(ev.error || ev.message, { kind: "window-error" });
});

window.__state = state;

const client = createSearchClient({
  workerUrl: searchWorkerUrl(),
  onResult({ query, result, generation }) {
    const rows = Array.isArray(result?.results) ? result.results : [];
    const payload = {
      query,
      generation,
      titles: rows.map((row) => row.title),
      ids: rows.map((row) => row.id),
      relevanceKind: rows.map((row) => row.relevanceKind ?? null),
      directClass: rows.map((row) => row.directClass ?? null),
      candidateCount: result?.meta?.candidateCount ?? null,
    };
    state.last = payload;
    state.published.push(payload);
  },
  onError({ query, generation, error }) {
    recordError(error, { kind: "onError", query, generation });
  },
  onReady(msg) {
    state.documentCount = msg?.documentCount ?? null;
  },
});

window.__client = client;

try {
  const retriever = new URLSearchParams(location.search).get("retriever") || "full-scan";
  state.retriever = retriever;
  const init = await fetch("/software-land-init.json").then((res) => {
    if (!res.ok) throw new Error(`software-land-init.json HTTP ${res.status}`);
    return res.json();
  });
  init.retriever = retriever;
  await client.init(init);
  await client.waitReady();
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}

window.__runQuery = (query, options = {}) => {
  return client.setQuery(query, options);
};

window.__dispose = () => {
  client.dispose();
};
