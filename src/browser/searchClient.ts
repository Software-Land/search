/**
 * Vanilla JS search client. No React.
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
import type { ProtocolMessage, SearchClientOptions, WorkerLike, WorkerSearchPayload } from "./types.js";

type PendingWaiter = (msg: ProtocolMessage) => void;

/** Package-safe URL for the bundled Worker module. */
export function searchWorkerUrl() {
  return new URL("./searchWorker.js", import.meta.url);
}

function defaultWorkerFactory(url: URL | string, options?: unknown): WorkerLike {
  return new Worker(url, { type: "module", ...((options || {}) as WorkerOptions) }) as WorkerLike;
}

export function createSearchClient({
  worker,
  workerUrl,
  workerFactory = defaultWorkerFactory,
  workerOptions,
  onResult,
  onClear,
  onError,
  onReady,
}: SearchClientOptions = {}) {
  const resolvedUrl = workerUrl ?? (worker ? undefined : searchWorkerUrl());
  const candidate = worker || (resolvedUrl ? workerFactory(resolvedUrl, workerOptions) : null);
  if (!candidate || typeof candidate.postMessage !== "function") {
    throw new Error("createSearchClient requires a worker or workerUrl");
  }
  const ownedWorker = candidate;

  let nextId = 0;
  let ready = false;
  let readyWaiters: Array<() => void> = [];
  let terminated = false;
  const pendingById = new Map<number, PendingWaiter>();
  const tInit = typeof performance !== "undefined" ? performance.now() : Date.now();
  const timings = { lastRoundTripMs: 0, lastSearchMs: 0 };

  function post(message: ProtocolMessage) {
    ownedWorker.postMessage(message);
  }

  function handleWorkerMessage(data: unknown) {
    if (!data || terminated) return;
    const msg = data as ProtocolMessage;
    if (msg.type === MSG.READY) {
      ready = true;
      const waiters = readyWaiters;
      readyWaiters = [];
      waiters.forEach((fn) => fn());
      onReady?.(msg);
    }
    const id = msg.requestId;
    if (typeof id === "number") {
      const waiter = pendingById.get(id);
      if (waiter) {
        pendingById.delete(id);
        waiter(msg);
      }
    }
  }

  const unsubscribe =
    typeof ownedWorker.subscribe === "function"
      ? ownedWorker.subscribe((data) => handleWorkerMessage(data))
      : null;
  if (ownedWorker.addEventListener) {
    ownedWorker.addEventListener("message", (ev) => handleWorkerMessage(ev.data));
  } else if (ownedWorker.onmessage === undefined && !unsubscribe) {
    ownedWorker.onmessage = (ev) => handleWorkerMessage(ev.data);
  }

  function waitReady() {
    if (ready) return Promise.resolve();
    return new Promise<void>((resolve) => {
      readyWaiters.push(() => resolve(undefined));
    });
  }

  function request(type: string, fields?: Record<string, unknown>) {
    const requestId = ++nextId;
    return new Promise<ProtocolMessage>((resolve) => {
      pendingById.set(requestId, resolve);
      post({ type, requestId, ...fields });
    });
  }

  async function init(payload: Record<string, unknown>) {
    const msg = await request(MSG.INIT, { payload });
    if (msg.type === MSG.ERROR) throw new Error(msg.error?.message || "init failed");
    return msg;
  }

  const session = createLatestWinsSession({
    async search(query, { signal, ...options } = {}) {
      await waitReady();
      const requestId = ++nextId;
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      const result = await new Promise((resolve, reject) => {
        pendingById.set(requestId, (msg) => {
          const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
          timings.lastRoundTripMs = ended - started;
          const payload = msg.payload as WorkerSearchPayload | undefined;
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
    setQuery(query: string, options?: Record<string, unknown>) {
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
