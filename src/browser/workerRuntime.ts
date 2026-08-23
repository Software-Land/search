/**
 * Worker-side runtime. No Worker / window / navigator globals.
 * The thin searchWorker.js glue posts messages in and out.
 */

import { MSG } from "./protocol.js";
import { isAbortError } from "../cancel.js";
import type { SearchEngine } from "../SearchEngine.js";
import type { SearchEngineOptions, SearchOptions, SearchPlugin } from "../types.js";
import type {
  InitPayload,
  ProtocolMessage,
  ReplyFn,
  WorkerRuntime,
  WorkerRuntimeFactories,
} from "./types.js";

type RunningSearch = { requestId?: number; abort: () => void };

export function createWorkerRuntime({ SearchEngine, english, dictionary }: WorkerRuntimeFactories = {}) {
  let engine: SearchEngine | null = null;
  let running: RunningSearch | null = null;
  let disposed = false;
  let exactPruningMode: "auto" | "exhaustive" = "auto";

  function replyError(reply: ReplyFn, requestId: number | undefined, err: unknown) {
    const rec = err && typeof err === "object" ? (err as { name?: string; message?: unknown }) : {};
    reply({
      type: MSG.ERROR,
      requestId,
      error: { name: rec.name || "Error", message: String(rec.message || err) },
    });
  }

  async function handleInit(message: ProtocolMessage, reply: ReplyFn) {
    if (!SearchEngine) {
      replyError(reply, message.requestId, new Error("createWorkerRuntime requires SearchEngine"));
      return;
    }
    try {
      const payload = (message.payload || {}) as InitPayload;
      const plugins: SearchPlugin[] = [];
      if (typeof english === "function") plugins.push(english(payload.englishOptions || {}));
      if (typeof dictionary === "function") {
        plugins.push(dictionary({ entries: payload.dictionaryEntries || [] }));
      }
      exactPruningMode =
        payload._exactPruningMode === "exhaustive" ? "exhaustive" : "auto";
      const documents = payload.documents || [];
      engine = SearchEngine.create({
        schema: payload.schema,
        plugins,
        lexicalIndex: payload.lexicalIndex,
        relationships: payload.relationships || null,
        relationshipStrategy: payload.relationshipStrategy,
        retriever: payload.retriever,
        candidateLimit: payload.candidateLimit ?? undefined,
        adaptive: payload.adaptive,
      } as SearchEngineOptions);
      const indexed = await engine.index(documents);
      payload.lexicalIndex = undefined;
      payload.documents = undefined;
      payload.relationships = undefined;
      reply({
        type: MSG.READY,
        requestId: message.requestId,
        documentCount: indexed.documentCount,
        indexBuildMs: indexed.buildMs,
      });
    } catch (err) {
      engine = null;
      replyError(reply, message.requestId, err);
    }
  }

  async function handleSearch(message: ProtocolMessage, reply: ReplyFn) {
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
    const options = { ...(message.options || {}), signal: ac.signal } as SearchOptions;
    try {
      // The Worker protocol forwards result rows and retrieval timings, not the
      // complete SearchEngine.searchDetailed diagnostic surface. Keep it on
      // the exact representative path instead of paying the full diagnostic
      // ranking fallback used by the public searchDetailed API.
      const detailed = await engine._searchDetailedAsync(
        String(message.query ?? ""),
        options,
        false,
        exactPruningMode
      );
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
            featureMs: detailed.meta?.featureMs,
            selectionMs: detailed.meta?.selectionMs,
            rankMs: detailed.meta?.rankMs,
            candidateCount: detailed.meta?.candidateCount,
            matchCount: detailed.meta?.matchCount,
            representativeSelection: detailed.meta?.representativeSelection,
            postingEntriesVisited: detailed.meta?.postingEntriesVisited,
            distinctDocumentsExamined: detailed.meta?.distinctDocumentsExamined,
            rawDocumentScans: detailed.meta?.rawDocumentScans,
            postingBlocksVisited: detailed.meta?.postingBlocksVisited,
            postingBlocksSkipped: detailed.meta?.postingBlocksSkipped,
            postingEntriesSkipped: detailed.meta?.postingEntriesSkipped,
            duplicatePostingEntriesAvoided: detailed.meta?.duplicatePostingEntriesAvoided,
            queryFormsExpanded: detailed.meta?.queryFormsExpanded,
            termsExpanded: detailed.meta?.termsExpanded,
            documentBlocksVisited: detailed.meta?.documentBlocksVisited,
            documentBlocksSkipped: detailed.meta?.documentBlocksSkipped,
            boundedBlocksSkipped: detailed.meta?.boundedBlocksSkipped,
            documentsFullyEvaluated: detailed.meta?.documentsFullyEvaluated,
            documentsBoundRejected: detailed.meta?.documentsBoundRejected,
            pruningSignaturesEncountered: detailed.meta?.pruningSignaturesEncountered,
            pruningRepresentativesRetained: detailed.meta?.pruningRepresentativesRetained,
            pruningFallbackReason: detailed.meta?.pruningFallbackReason,
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

  function handleCancel(message: ProtocolMessage) {
    if (running && (!message.requestId || running.requestId === message.requestId)) {
      running.abort();
    }
  }

  function handleDispose() {
    disposed = true;
    if (running) running.abort();
    running = null;
    engine = null;
    exactPruningMode = "auto";
  }

  async function dispatch(message: ProtocolMessage | null | undefined, reply: ReplyFn) {
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
export function createLoopbackTransport(runtime: WorkerRuntime) {
  const listeners = new Set<(msg: ProtocolMessage) => void>();
  const inbound: ProtocolMessage[] = [];
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (inbound.length) {
      const msg = inbound.shift();
      await runtime.dispatch(msg, (reply) => {
        for (const fn of listeners) fn(reply);
      });
    }
    pumping = false;
  }

  return {
    postMessage(message: ProtocolMessage) {
      inbound.push(message);
      queueMicrotask(() => {
        pump();
      });
    },
    subscribe(fn: (msg: ProtocolMessage) => void) {
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
