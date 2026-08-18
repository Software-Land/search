/**
 * Vanilla JS Search V2 client. No React.
 *
 * UI thread
 *   → SearchClient (latest-wins + request ids)
 *     → Worker postMessage
 *       → SearchEngine
 *
 * Initialization happens once. Queries send only the string + options.
 */

import { MSG } from "./protocol.js";
import { createLatestWinsSession } from "./latestWins.js";

/** Package-safe URL for the bundled Worker module. */
export function searchWorkerUrl() {
  return new URL("./searchWorker.js", import.meta.url);
}

/** @param {URL | string} url @param {unknown} [options] @returns {import("./types.js").WorkerLike} */
function defaultWorkerFactory(url, options) {
  return /** @type {import("./types.js").WorkerLike} */ (new Worker(url, { type: "module", ...(options || {}) }));
}

/**
 * @param {import("./types.js").SearchClientOptions} [options]
 */
export function createSearchClient({
  worker,
  workerUrl,
  workerFactory = defaultWorkerFactory,
  workerOptions,
  onResult,
  onClear,
  onError,
  onReady,
} = {}) {
  const resolvedUrl = workerUrl ?? (worker ? undefined : searchWorkerUrl());
  const candidate = worker || (resolvedUrl ? workerFactory(resolvedUrl, workerOptions) : null);
  if (!candidate || typeof candidate.postMessage !== "function") {
    throw new Error("createSearchClient requires a worker or workerUrl");
  }
  const ownedWorker = candidate;

  let nextId = 0;
  let ready = false;
  /** @type {Array<() => void>} */
  let readyWaiters = [];
  let terminated = false;
  /** @type {Map<number, (msg: import("./types.js").ProtocolMessage) => void>} */
  const pendingById = new Map();
  const tInit = typeof performance !== "undefined" ? performance.now() : Date.now();
  const timings = { lastRoundTripMs: 0, lastSearchMs: 0 };

  /** @param {import("./types.js").ProtocolMessage} message */
  function post(message) {
    ownedWorker.postMessage(message);
  }

  /** @param {import("./types.js").ProtocolMessage | null | undefined} data */
  function handleWorkerMessage(data) {
    if (!data || terminated) return;
    if (data.type === MSG.READY) {
      ready = true;
      const waiters = readyWaiters;
      readyWaiters = [];
      waiters.forEach((fn) => fn());
      onReady?.(data);
    }
    const id = data.requestId;
    if (typeof id === "number") {
      const waiter = pendingById.get(id);
      if (waiter) {
        pendingById.delete(id);
        waiter(data);
      }
    }
  }

  const unsubscribe =
    typeof ownedWorker.subscribe === "function"
      ? ownedWorker.subscribe((data) => handleWorkerMessage(/** @type {import("./types.js").ProtocolMessage} */ (data)))
      : null;
  if (ownedWorker.addEventListener) {
    ownedWorker.addEventListener("message", (/** @type {{ data: unknown }} */ ev) => handleWorkerMessage(/** @type {import("./types.js").ProtocolMessage} */ (ev.data)));
  } else if (ownedWorker.onmessage === undefined && !unsubscribe) {
    ownedWorker.onmessage = (/** @type {{ data: unknown }} */ ev) => handleWorkerMessage(/** @type {import("./types.js").ProtocolMessage} */ (ev.data));
  }

  function waitReady() {
    if (ready) return Promise.resolve();
    return new Promise((resolve) => {
      readyWaiters.push(() => resolve(undefined));
    });
  }

  /** @param {string} type @param {Record<string, unknown>} [fields] */
  function request(type, fields) {
    const requestId = ++nextId;
    return new Promise((resolve) => {
      pendingById.set(requestId, resolve);
      post({ type, requestId, ...fields });
    });
  }

  /** @param {Record<string, unknown>} payload */
  async function init(payload) {
    const msg = await request(MSG.INIT, { payload });
    if (msg.type === MSG.ERROR) throw new Error(msg.error?.message || "init failed");
    return msg;
  }

  const session = createLatestWinsSession({
    async search(/** @type {string} */ query, /** @type {Record<string, unknown> & { signal?: AbortSignal }} */ { signal, ...options } = {}) {
      await waitReady();
      const requestId = ++nextId;
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      const result = await new Promise((resolve, reject) => {
        pendingById.set(requestId, (/** @type {import("./types.js").ProtocolMessage} */ msg) => {
          const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
          timings.lastRoundTripMs = ended - started;
          const payload = /** @type {import("./types.js").WorkerSearchPayload | undefined} */ (msg.payload);
          timings.lastSearchMs = payload?.meta?.totalMs || 0;
          if (msg.type === MSG.ABORTED) {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          if (msg.type === MSG.ERROR) {
            const err = new Error(msg.error?.message || "search failed");
            err.name = msg.error?.name || "Error";
            reject(err);
            return;
          }
          resolve(msg.payload);
        });
        const onAbort = () => {
          post({ type: MSG.CANCEL, requestId });
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else if (typeof signal.addEventListener === "function") {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        post({ type: MSG.SEARCH, requestId, query, options });
      });
      return result;
    },
    onResult,
    onClear,
    onError,
  });

  function terminate() {
    if (terminated) return;
    terminated = true;
    session.dispose();
    post({ type: MSG.DISPOSE });
    pendingById.clear();
    if (typeof ownedWorker.terminate === "function") ownedWorker.terminate();
    unsubscribe?.();
  }

  return {
    init,
    /**
     * @param {string} query
     * @param {Record<string, unknown>} [options]
     */
    setQuery(query, options) {
      return session.setQuery(query, options);
    },
    dispose: terminate,
    terminate,
    waitReady,
    stats: () => session.stats(),
    currentGeneration: () => session.currentGeneration(),
    timings: () => ({ ...timings, initElapsedMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - tInit }),
    get ready() {
      return ready;
    },
  };
}
