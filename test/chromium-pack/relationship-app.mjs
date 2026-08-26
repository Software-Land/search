import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const state = {
  published: [],
  errors: [],
  workerUrl: String(searchWorkerUrl()),
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
    const related = Array.isArray(result?.related) ? result.related : [];
    state.published.push({
      query,
      generation,
      ids: rows.map((row) => row.id),
      relatedIds: related.map((row) => row.id),
      relatedType: related.map((row) => row.explanation?.relationship?.type ?? null),
      relatedProvenance: related.map((row) => row.explanation?.relationship?.provenance ?? null),
      retrievalSources: rows.map((row) => row.retrievalSources || null),
    });
  },
  onError({ query, generation, error }) {
    recordError(error, { kind: "onError", query, generation });
  },
});

window.__client = client;

try {
  await client.init({
    documents: [
      { id: "qa-guide", title: "Quality Assurance Guide", body: "qa process handbook" },
      { id: "testing", title: "Testing in Software Engineering", body: "unit testing methods" },
      { id: "http-doc", title: "What is HTTP?", body: "http methods and status codes" },
      { id: "authn", title: "Login Flow", body: "password authentication cookies" },
      { id: "doc-a", title: "Krypton Primary", body: "krypton only body text" },
      { id: "doc-b", title: "Xenon Neighbor", body: "xenon only body text" },
    ],
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    dictionaryEntries: [
      { key: "qa", aliases: [["quality", "assurance"]] },
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
      { key: "appsec", aliases: [["application", "security"]] },
    ],
    relationshipMap: {
      qa: [{ kind: "equivalent", to: { form: "testing" } }],
      hypertext: [{ kind: "related", to: { concept: "http" } }],
      appsec: [{ kind: "related", to: { form: "authentication" } }],
      "doc-a": [{ kind: "related", to: { document: "doc-b" } }],
    },
    relationships: {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        "doc-a": [{ target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" }],
      },
    },
    relationshipStrategy: "hybrid",
    retriever: "indexed",
  });
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
