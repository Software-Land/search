/**
 * Worker-side runtime. No Worker / window / navigator globals.
 * The thin searchWorker.js glue posts messages in and out.
 */

import { MSG } from "./protocol.js";
import { isAbortError } from "../cancel.js";

/**
 * @param {import("./types.js").WorkerRuntimeFactories} [factories]
 */
export function createWorkerRuntime({ SearchEngine, english, dictionary } = {}) {
  /** @type {import("../index.js").SearchEngine | null} */
  let engine = null;
  /** @type {{ requestId?: number, abort: () => void } | null} */
  let running = null;
  let disposed = false;

  /** @param {import("./types.js").ReplyFn} reply @param {number | undefined} requestId @param {unknown} err */
  /** @param {import("./types.js").ReplyFn} reply @param {number | undefined} requestId @param {unknown} err */
  function replyError(reply, requestId, err) {
    const rec = err && typeof err === "object" ? /** @type {{ name?: string, message?: unknown }} */ (err) : {};
    reply({
      type: MSG.ERROR,
      requestId,
      error: { name: rec.name || "Error", message: String(rec.message || err) },
    });
  }

  /** @param {import("./types.js").ProtocolMessage} message @param {import("./types.js").ReplyFn} reply */
  async function handleInit(message, reply) {
    if (!SearchEngine) {
      replyError(reply, message.requestId, new Error("createWorkerRuntime requires SearchEngine"));
      return;
    }
    const payload = /** @type {import("./types.js").InitPayload} */ (message.payload || {});
    const plugins = [];
    if (typeof english === "function") plugins.push(english(payload.englishOptions || {}));
    if (typeof dictionary === "function") {
      plugins.push(dictionary({ entries: payload.dictionaryEntries || [] }));
    }
    engine = SearchEngine.create({
      schema: payload.schema,
      plugins,
      relationships: payload.relationships || null,
      relationshipStrategy: payload.relationshipStrategy,
      retriever: payload.retriever,
      candidateLimit: payload.candidateLimit ?? undefined,
      adaptive: payload.adaptive,
    });
    const indexed = await engine.index(payload.documents || []);
    reply({ type: MSG.READY, requestId: message.requestId, documentCount: indexed.documentCount });
  }

  /** @param {import("./types.js").ProtocolMessage} message @param {import("./types.js").ReplyFn} reply */
  async function handleSearch(message, reply) {
    if (!engine) {
      replyError(reply, message.requestId, new Error("Worker engine is not initialized"));
      return;
    }
    if (running) {
      running.abort();
      running = null;
    }
    const ac = new AbortController();
    running = {
      requestId: message.requestId,
      abort() {
        ac.abort();
      },
    };
    const options = { ...(message.options || {}), signal: ac.signal };
    try {
      const detailed = await engine.searchDetailedAsync(String(message.query ?? ""), options);
      if (running && running.requestId === message.requestId) running = null;
      reply({
        type: MSG.RESULT,
        requestId: message.requestId,
        payload: {
          results: detailed.results,
          related: detailed.related,
          meta: {
            totalMs: detailed.meta?.totalMs,
            retrieveMs: detailed.meta?.retrieveMs,
            rankMs: detailed.meta?.rankMs,
            candidateCount: detailed.meta?.candidateCount,
            relationshipStrategy: detailed.meta?.relationshipStrategy,
            relatedCount: detailed.meta?.relatedCount,
          },
        },
      });
    } catch (err) {
      if (running && running.requestId === message.requestId) running = null;
      if (isAbortError(err)) {
        reply({ type: MSG.ABORTED, requestId: message.requestId });
        return;
      }
      replyError(reply, message.requestId, err);
    }
  }

  /** @param {import("./types.js").ProtocolMessage} message */
  function handleCancel(message) {
    if (running && (!message.requestId || running.requestId === message.requestId)) {
      running.abort();
    }
  }

  function handleDispose() {
    disposed = true;
    if (running) running.abort();
    running = null;
    engine = null;
  }

  /** @param {import("./types.js").ProtocolMessage | null | undefined} message @param {import("./types.js").ReplyFn} reply */
  async function dispatch(message, reply) {
    if (!message || disposed) return;
    switch (message.type) {
      case MSG.INIT:
        await handleInit(message, reply);
        break;
      case MSG.SEARCH:
        // Do not await: the worker event loop must process cancel messages
        // while searchDetailedAsync yields at checkpoints.
        handleSearch(message, reply);
        break;
      case MSG.CANCEL:
        handleCancel(message);
        break;
      case MSG.DISPOSE:
        handleDispose();
        break;
      default:
        break;
    }
  }

  return {
    dispatch,
    get initialized() {
      return Boolean(engine);
    },
  };
}

/**
 * In-process loopback used by tests. Models Worker message ordering:
 * inbound messages are queued as microtasks so a cancel can land between yields.
 */
/** @param {import("./types.js").WorkerRuntime} runtime */
export function createLoopbackTransport(runtime) {
  /** @type {Set<(msg: import("./types.js").ProtocolMessage) => void>} */
  const listeners = new Set();
  /** @type {import("./types.js").ProtocolMessage[]} */
  const inbound = [];
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (inbound.length) {
      const msg = inbound.shift();
      await runtime.dispatch(msg, (/** @type {import("./types.js").ProtocolMessage} */ reply) => {
        for (const fn of listeners) fn(reply);
      });
    }
    pumping = false;
  }

  return {
    postMessage(/** @type {import("./types.js").ProtocolMessage} */ message) {
      inbound.push(message);
      queueMicrotask(() => {
        pump();
      });
    },
    subscribe(/** @type {(msg: import("./types.js").ProtocolMessage) => void} */ fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    terminate() {
      inbound.length = 0;
      runtime.dispatch({ type: MSG.DISPOSE }, () => {});
      listeners.clear();
    },
  };
}
