import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const SIZES = [1000, 2000, 5000];
const RETRIEVERS = ["full-scan", "indexed"];
const QUERY_RARE = "ZX9 UniqueRareTitle";
const QUERY_COMMON = "search";
const QUERY_ADVERSARIAL = "zz";
const QUERIES = [
  { name: "rare-exact", query: QUERY_RARE },
  { name: "high-df", query: QUERY_COMMON },
  { name: "adversarial-short-literal", query: QUERY_ADVERSARIAL },
];
const VOCAB = [
  "the", "of", "and", "search", "index", "document", "query", "title", "body",
  "token", "network", "protocol", "security", "tls", "vpn", "worker", "rank",
];

function mixedDocs(n) {
  const floodN = Math.min(400, Math.max(0, n - 8));
  const docs = [
    { id: "rare-exact", title: QUERY_RARE, body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security search document" },
    {
      id: "winner-short-literal",
      title: "Zzwinner unique ranking title analog",
      body: "unrelated body without the query token repeated",
    },
  ];
  for (let i = 0; i < floodN; i += 1) {
    docs.push({
      id: `zz-flood-${String(i).padStart(5, "0")}`,
      title: `Unrelated filler ${i}`,
      body: Array.from({ length: 16 }, () => "zz").join(" "),
    });
  }
  for (let i = docs.length; i < n; i += 1) {
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

async function runMode(retriever, n) {
  const published = [];
  const client = createSearchClient({
    workerUrl: searchWorkerUrl(),
    onResult({ query: q, result, generation }) {
      published.push({
        query: q,
        generation,
        ids: (result?.results || []).map((row) => row.id),
        titles: (result?.results || []).map((row) => row.title),
        meta: result?.meta || {},
      });
    },
    onError({ query: q, generation, error }) {
      recordError(error, { kind: "onError", query: q, generation, retriever, n });
    },
  });
  await client.init({
    documents: mixedDocs(n),
    schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
    dictionaryEntries: [],
    retriever,
    candidateLimit: 200,
    relationshipStrategy: "none",
  });
  await client.waitReady();
  const rows = [];
  for (const { name, query } of QUERIES) {
    const generation = client.setQuery(query, { limit: 10 });
    const started = performance.now();
    const hit = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 45000;
      const tick = () => {
        if (state.errors.length) {
          reject(new Error(JSON.stringify(state.errors)));
          return;
        }
        const found = published.find((row) => row.generation === generation);
        if (found) {
          resolve(found);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`${retriever} n=${n} ${query} timed out`));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
    rows.push({
      retriever,
      query,
      queryFamily: name,
      n,
      candidateCount: hit?.meta?.candidateCount ?? null,
      retrieveMs: hit?.meta?.retrieveMs ?? null,
      featureMs: hit?.meta?.featureMs ?? null,
      rankMs: hit?.meta?.rankMs ?? null,
      totalMs: hit?.meta?.totalMs ?? null,
      wallMs: performance.now() - started,
      topId: hit?.ids?.[0] ?? null,
      topTitle: hit?.titles?.[0] ?? null,
    });
  }
  client.dispose();
  return rows;
}

try {
  for (const n of SIZES) {
    for (const retriever of RETRIEVERS) {
      state.results.push(...(await runMode(retriever, n)));
    }
  }
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}
