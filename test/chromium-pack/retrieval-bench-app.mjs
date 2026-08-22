import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const N = 2000;
const QUERY_RARE = "ZX9 UniqueRareTitle";
const QUERY_COMMON = "search";
const VOCAB = [
  "the", "of", "and", "search", "index", "document", "query", "title", "body",
  "token", "network", "protocol", "security", "tls", "vpn", "worker", "rank",
];

function mixedDocs() {
  const docs = [
    { id: "rare-exact", title: QUERY_RARE, body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security search document" },
  ];
  for (let i = docs.length; i < N; i += 1) {
    const words = [];
    for (let w = 0; w < 24; w += 1) words.push(VOCAB[(i + w) % VOCAB.length]);
    docs.push({
      id: `d${String(i).padStart(5, "0")}`,
      title: `Note ${i} ${VOCAB[i % VOCAB.length]}`,
      body: words.join(" "),
    });
  }
  return docs;
}

const state = {
  errors: [],
  workerUrl: String(searchWorkerUrl()),
  results: [],
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

async function runMode(retriever, query) {
  const published = [];
  const client = createSearchClient({
    workerUrl: searchWorkerUrl(),
    onResult({ query: q, result, generation }) {
      published.push({
        query: q,
        generation,
        ids: (result?.results || []).map((row) => row.id),
        meta: result?.meta || {},
      });
    },
    onError({ query: q, generation, error }) {
      recordError(error, { kind: "onError", query: q, generation, retriever });
    },
  });
  await client.init({
    documents: mixedDocs(),
    schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
    dictionaryEntries: [],
    retriever,
    candidateLimit: 200,
    relationshipStrategy: "none",
  });
  await client.waitReady();
  const generation = client.setQuery(query, { limit: 10 });
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 45000;
    const tick = () => {
      if (state.errors.length) {
        reject(new Error(JSON.stringify(state.errors)));
        return;
      }
      const hit = published.find((row) => row.generation === generation);
      if (hit) {
        resolve(hit);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`${retriever} ${query} timed out`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
  const hit = published.find((row) => row.generation === generation);
  const wallMs = performance.now() - started;
  client.dispose();
  return {
    retriever,
    query,
    n: N,
    candidateCount: hit?.meta?.candidateCount ?? null,
    retrieveMs: hit?.meta?.retrieveMs ?? null,
    featureMs: hit?.meta?.featureMs ?? null,
    rankMs: hit?.meta?.rankMs ?? null,
    totalMs: hit?.meta?.totalMs ?? null,
    wallMs,
    topId: hit?.ids?.[0] ?? null,
  };
}

try {
  for (const retriever of ["full-scan", "indexed", "adaptive"]) {
    state.results.push(await runMode(retriever, QUERY_RARE));
    state.results.push(await runMode(retriever, QUERY_COMMON));
  }
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}
