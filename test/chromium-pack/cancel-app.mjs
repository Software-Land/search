import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

const state = {
  messages: [],
  clientPublished: [],
  cleared: 0,
  errors: [],
  outcome: null,
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

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for ${predicate}`));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 15);
  });
}

const documents = Array.from({ length: 5000 }, (_, i) => ({
  id: `d${i}`,
  title: `Note ${i}`,
  body: `secure network policy ${i} secure network controls`,
}));
documents.push({
  id: "only-zephyr",
  title: "Zephyr Beacon",
  body: "unique zephyrbeacon marker",
});

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

try {
  const worker = new Worker(searchWorkerUrl(), { type: "module" });
  worker.addEventListener("message", (ev) => {
    state.messages.push(ev.data);
  });
  worker.postMessage({
    type: "init",
    requestId: 1,
    payload: { documents, schema, configuredConcepts: [] },
  });
  const ready = await waitFor(
    () => state.messages.find((msg) => msg.requestId === 1),
    45_000
  );
  if (ready.type !== "ready") {
    throw new Error(`worker init failed: ${JSON.stringify(ready)}`);
  }

  worker.postMessage({
    type: "search",
    requestId: 2,
    query: "secure network",
    options: { limit: 10 },
  });
  worker.postMessage({ type: "cancel", requestId: 2 });
  const cancelled = await waitFor(
    () => state.messages.find((msg) => msg.requestId === 2),
    45_000
  );
  if (cancelled.type !== "aborted") {
    throw new Error(`expected aborted for request 2, got ${JSON.stringify(cancelled)}`);
  }
  if (state.messages.some((msg) => msg.requestId === 2 && msg.type === "result")) {
    throw new Error("cancelled request published a result");
  }

  worker.postMessage({
    type: "search",
    requestId: 3,
    query: "zephyrbeacon",
    options: { limit: 5 },
  });
  const replacement = await waitFor(
    () => state.messages.find((msg) => msg.requestId === 3),
    45_000
  );
  if (replacement.type !== "result") {
    throw new Error(`replacement search failed: ${JSON.stringify(replacement)}`);
  }
  const replacementIds = (replacement.payload?.results || []).map((row) => row.id);
  if (replacementIds[0] !== "only-zephyr") {
    throw new Error(`replacement ids were ${JSON.stringify(replacementIds)}`);
  }
  if (state.messages.some((msg) => msg.requestId === 2 && msg.type === "result")) {
    throw new Error("superseded request published a result after replacement");
  }

  worker.postMessage({
    type: "search",
    requestId: 4,
    query: "secure network",
    options: { limit: 10 },
  });
  worker.postMessage({ type: "dispose" });
  const disposed = await waitFor(
    () => state.messages.find((msg) => msg.requestId === 4) || null,
    45_000
  );
  if (disposed.type !== "aborted") {
    throw new Error(`dispose expected aborted for request 4, got ${JSON.stringify(disposed)}`);
  }
  if (state.messages.some((msg) => msg.requestId === 4 && msg.type === "result")) {
    throw new Error("disposed request published a result");
  }
  worker.terminate();

  const client = createSearchClient({
    workerUrl: searchWorkerUrl(),
    onResult({ query, result }) {
      state.clientPublished.push({
        query,
        ids: (result?.results || []).map((row) => row.id),
      });
    },
    onClear() {
      state.cleared += 1;
    },
    onError({ error }) {
      recordError(error, { kind: "client" });
    },
  });
  await client.init({
    documents: [
      { id: "nfc", title: "NFC", body: "Near-field communication." },
      { id: "vpn", title: "VPN", body: "Virtual private network." },
    ],
    schema,
    configuredConcepts: [],
  });
  await client.waitReady();
  client.setQuery("nfc");
  await waitFor(
    () => state.clientPublished.some((row) => row.query === "nfc" && row.ids[0] === "nfc"),
    20_000
  );
  client.setQuery("");
  await waitFor(() => state.cleared > 0, 20_000);
  client.dispose();

  state.outcome = {
    cancelledType: cancelled.type,
    replacementIds,
    disposedType: disposed.type,
    cleared: state.cleared,
    clientIds: state.clientPublished.map((row) => row.ids[0]),
  };
  window.__booted = true;
} catch (err) {
  recordError(err, { kind: "cancel" });
  window.__bootError = String(err?.message || err);
  window.__booted = false;
}
