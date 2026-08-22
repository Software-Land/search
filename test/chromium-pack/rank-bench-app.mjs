import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const QUERY = "rankprobe";
const C = 1000;

function docsHomogeneous() {
  const docs = [];
  for (let i = 0; i < C; i += 1) {
    docs.push({
      id: `d${String(i).padStart(5, "0")}`,
      title: `Note ${i} ${QUERY}`,
      body: `${QUERY} body`,
    });
  }
  return docs;
}

function docsFewBuckets() {
  const exactN = 100;
  const docs = [];
  for (let i = 0; i < C; i += 1) {
    if (i < exactN) docs.push({ id: `e${String(i).padStart(5, "0")}`, title: QUERY, body: `${QUERY} exact` });
    else docs.push({ id: `d${String(i).padStart(5, "0")}`, title: `Note ${i} ${QUERY}`, body: `${QUERY} body` });
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

async function runWorkload(name, documents) {
  const published = [];
  const client = createSearchClient({
    workerUrl: searchWorkerUrl(),
    onResult({ query, result, generation }) {
      published.push({
        query,
        generation,
        ids: (result?.results || []).map((row) => row.id),
        meta: result?.meta || {},
      });
    },
    onError({ query, generation, error }) {
      recordError(error, { kind: "onError", query, generation, workload: name });
    },
  });
  await client.init({
    documents,
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    dictionaryEntries: [],
    retriever: "full-scan",
    relationshipStrategy: "none",
  });
  await client.waitReady();
  const generation = client.setQuery(QUERY, { limit: 10 });
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
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
        reject(new Error(`${name} timed out`));
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
    workload: name,
    C,
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
  state.results.push(await runWorkload("homogeneous", docsHomogeneous()));
  state.results.push(await runWorkload("few-buckets", docsFewBuckets()));
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}
