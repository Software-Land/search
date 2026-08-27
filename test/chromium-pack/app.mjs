import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const state = {
  published: [],
  errors: [],
  workerUrl: String(searchWorkerUrl()),
  normalGeneration: null,
  latestWinsGeneration: null,
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
    state.published.push({
      query,
      generation,
      ids: rows.map((row) => row.id),
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
      { id: "nfc", title: "NFC", body: "Near-field communication." },
      { id: "vpn", title: "VPN", body: "Virtual private network." },
    ],
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    configuredConcepts: [],
  });
  await client.waitReady();
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "init" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}

window.__runNormalSearch = () => {
  state.normalGeneration = client.setQuery("nfc");
  return state.normalGeneration;
};

window.__runLatestWins = () => {
  client.setQuery("n");
  state.latestWinsGeneration = client.setQuery("nfc");
  return state.latestWinsGeneration;
};

window.__dispose = () => {
  client.dispose();
};
