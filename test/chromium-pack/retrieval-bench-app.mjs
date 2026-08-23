import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";
import { compileLexicalIndex } from "@software-land/search/lexical";
import { morphology } from "@software-land/search";

const PARAMS = new URLSearchParams(window.location.search);
const requestedSizes = String(PARAMS.get("sizes") || "")
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const SIZES = requestedSizes.length ? requestedSizes : [1000, 2000, 5000];
const MEASURE_BROWSER_MEMORY = PARAMS.get("memory") === "1";
const MODES = ["full-scan", "indexed-fallback", "indexed-precompiled"];
const QUERY_RARE = "ZX9 UniqueRareTitle";
const QUERY_COMMON = "the";
const QUERY_ADVERSARIAL = "zz";
const QUERY_INDEPENDENT_TITLE = "probezz";
const QUERY_MACHINE_PREFIX = "machine l";
const QUERIES = [
  { name: "rare-exact", query: QUERY_RARE },
  { name: "high-df", query: QUERY_COMMON },
  { name: "adversarial-short-literal", query: QUERY_ADVERSARIAL },
  { name: "adversarial-independent-title-token", query: QUERY_INDEPENDENT_TITLE },
  { name: "software-land-machine-prefix", query: QUERY_MACHINE_PREFIX },
];
const VOCAB = [
  "the", "of", "and", "search", "index", "document", "query", "title", "body",
  "token", "network", "protocol", "security", "tls", "vpn", "worker", "rank",
];

function mixedDocs(n) {
  const floodN = Math.min(300, Math.max(0, Math.floor((n - 10) / 3)));
  const docs = [
    { id: "rare-exact", title: QUERY_RARE, body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security search document" },
    {
      id: "winner-short-literal",
      title: "Zzwinner unique ranking title analog",
      body: "unrelated body without the query token repeated",
    },
    {
      id: "winner-independent-title-token",
      title: "The Probezz",
      body: "notes",
    },
    {
      id: "winner-machine-prefix",
      title: "Machine Learning",
      body: "guide",
    },
  ];
  for (let i = 0; i < floodN; i += 1) {
    docs.push({
      id: `zz-flood-${String(i).padStart(5, "0")}`,
      title: `Unrelated filler ${i}`,
      body: Array.from({ length: 16 }, () => "zz").join(" "),
    });
  }
  for (let i = 0; i < floodN; i += 1) {
    docs.push({
      id: `probezz-flood-${String(i).padStart(5, "0")}`,
      title: `Notes probezz extra extra extra ${i}`,
      body: Array.from({ length: 16 }, () => "probezz").join(" "),
    });
  }
  for (let i = 0; i < floodN; i += 1) {
    docs.push({
      id: `machine-flood-${String(i).padStart(5, "0")}`,
      title: `Machine logs extra extra extra ${i}`,
      body: Array.from({ length: 16 }, () => "machine logs").join(" "),
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

async function browserMemoryBytes() {
  if (!MEASURE_BROWSER_MEMORY) return null;
  if (typeof performance.measureUserAgentSpecificMemory !== "function") return null;
  try {
    const measurement = await Promise.race([
      performance.measureUserAgentSpecificMemory(),
      new Promise((resolve) => setTimeout(() => resolve(null), 30_000)),
    ]);
    return typeof measurement?.bytes === "number" ? measurement.bytes : null;
  } catch {
    return null;
  }
}

async function runMode(mode, n) {
  const documents = mixedDocs(n);
  const english = morphology();
  const precompileStarted = performance.now();
  let lexicalIndex = mode === "indexed-precompiled"
    ? compileLexicalIndex(documents, {
        schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
        lemma: english.lemma,
        analyzerId: english.indexIdentity,
      })
    : null;
  const precompileMs = mode === "indexed-precompiled" ? performance.now() - precompileStarted : 0;
  const artifactBytes = lexicalIndex ? new TextEncoder().encode(JSON.stringify(lexicalIndex)).byteLength : 0;
  const retriever = mode === "full-scan" ? "full-scan" : "indexed";
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
      recordError(error, { kind: "onError", query: q, generation, mode, n });
    },
  });
  const initStarted = performance.now();
  const ready = await client.init({
    documents,
    schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
    lexicalIndex,
    dictionaryEntries: [],
    retriever,
    candidateLimit: 200,
    relationshipStrategy: "none",
  });
  await client.waitReady();
  const initMs = performance.now() - initStarted;
  lexicalIndex = null;
  const browserHeapAfter = await browserMemoryBytes();
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
          reject(new Error(`${mode} n=${n} ${query} timed out`));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
    rows.push({
      mode,
      retriever,
      query,
      queryFamily: name,
      n,
      candidateCount: hit?.meta?.candidateCount ?? null,
      matchCount: hit?.meta?.matchCount ?? null,
      representativeSelection: hit?.meta?.representativeSelection ?? null,
      postingEntriesVisited: hit?.meta?.postingEntriesVisited ?? null,
      distinctDocumentsExamined: hit?.meta?.distinctDocumentsExamined ?? null,
      rawDocumentScans: hit?.meta?.rawDocumentScans ?? null,
      retrieveMs: hit?.meta?.retrieveMs ?? null,
      featureMs: hit?.meta?.featureMs ?? null,
      selectionMs: hit?.meta?.selectionMs ?? null,
      rankMs: hit?.meta?.rankMs ?? null,
      totalMs: hit?.meta?.totalMs ?? null,
      wallMs: performance.now() - started,
      precompileMs,
      artifactBytes,
      initMs,
      workerIndexBuildMs: ready?.indexBuildMs ?? null,
      browserHeapBytes: browserHeapAfter,
      topId: hit?.ids?.[0] ?? null,
      topTitle: hit?.titles?.[0] ?? null,
    });
  }
  client.dispose();
  return rows;
}

try {
  for (const n of SIZES) {
    for (const mode of MODES) {
      state.results.push(...(await runMode(mode, n)));
    }
  }
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}
