/**
 * Worker-side runtime. No Worker / window / navigator globals.
 * The thin searchWorker.js glue posts messages in and out.
 */

import { MSG } from "./protocol.js";
import { isAbortError } from "../cancel.js";
import { InvalidConfigurationError } from "../errors.js";
import { compileAuthoredRelevance as defaultCompileAuthoredRelevance } from "../dictionary.js";
import { mergeEditorialRelationships } from "../relationshipMap.js";
import type { SearchEngine } from "../SearchEngine.js";
import type { SearchEngineOptions, SearchOptions } from "../types.js";
import type {
  InitPayload,
  ProtocolMessage,
  ReplyFn,
  WorkerRuntime,
  WorkerRuntimeFactories,
} from "./types.js";

type RunningSearch = { requestId?: number; abort: () => void };

function publicWorkerMeta(meta?: any) {
  return {
    totalMs: meta?.totalMs,
    retrieveMs: meta?.retrieveMs,
    featureMs: meta?.featureMs,
    selectionMs: meta?.selectionMs,
    rankMs: meta?.rankMs,
    candidateCount: meta?.candidateCount,
    matchCount: meta?.matchCount,
    relatedCount: meta?.relatedCount,
    relationshipStrategy: meta?.relationshipStrategy,
  };
}

function retrievalDiagnosticMeta(meta?: any) {
  return {
    representativeSelection: meta?.representativeSelection,
    postingEntriesVisited: meta?.postingEntriesVisited,
    distinctDocumentsExamined: meta?.distinctDocumentsExamined,
    rawDocumentScans: meta?.rawDocumentScans,
    postingBlocksVisited: meta?.postingBlocksVisited,
    postingBlocksSkipped: meta?.postingBlocksSkipped,
    postingEntriesSkipped: meta?.postingEntriesSkipped,
    duplicatePostingEntriesAvoided: meta?.duplicatePostingEntriesAvoided,
    queryFormsExpanded: meta?.queryFormsExpanded,
    termsExpanded: meta?.termsExpanded,
    documentBlocksVisited: meta?.documentBlocksVisited,
    documentBlocksSkipped: meta?.documentBlocksSkipped,
    boundedBlocksSkipped: meta?.boundedBlocksSkipped,
    documentsFullyEvaluated: meta?.documentsFullyEvaluated,
    documentsBoundRejected: meta?.documentsBoundRejected,
    pruningSignaturesEncountered: meta?.pruningSignaturesEncountered,
    pruningRepresentativesRetained: meta?.pruningRepresentativesRetained,
    pruningFallbackReason: meta?.pruningFallbackReason,
  };
}

export function createWorkerRuntime({
  SearchEngine,
  english,
  dictionary,
  compileAuthoredRelevance,
}: WorkerRuntimeFactories = {}) {
  let engine: SearchEngine | null = null;
  let running: RunningSearch | null = null;
  let disposed = false;
  let exactPruningMode: "auto" | "exhaustive" = "auto";
  let includeRetrievalDiagnostics = false;

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
      const plugins = [];
      if (typeof english === "function") plugins.push(english(payload.englishOptions || {}));
      const hasCustomCompiler = typeof compileAuthoredRelevance === "function";
      const hasLegacyDictionary = typeof dictionary === "function";
      const hasRelationshipMap = payload.relationshipMap != null;
      // 1. custom compileAuthoredRelevance, if supplied
      // 2. otherwise built-in full compiler when relationshipMap is authored
      //    or no legacy dictionary factory is present
      // 3. legacy custom dictionary factory only when relationshipMap is absent
      if (hasLegacyDictionary && hasRelationshipMap && !hasCustomCompiler) {
        throw new InvalidConfigurationError(
          "createWorkerRuntime({ dictionary }) cannot compile relationshipMap; supply compileAuthoredRelevance for full authored relevance, or omit relationshipMap to use the legacy dictionary factory",
          { field: "relationshipMap", expected: "compileAuthoredRelevance" }
        );
      }
      exactPruningMode =
        payload._exactPruningMode === "exhaustive" ? "exhaustive" : "auto";
      includeRetrievalDiagnostics = payload._includeRetrievalDiagnostics === true;
      const documents = payload.documents || [];
      let authored = null;
      if (hasCustomCompiler || hasRelationshipMap || !hasLegacyDictionary) {
        const compile = hasCustomCompiler ? compileAuthoredRelevance : defaultCompileAuthoredRelevance;
        authored = compile({
          entries: payload.dictionaryEntries || [],
          relationshipMap: payload.relationshipMap,
          documents,
        });
        plugins.push(...authored.plugins);
      } else {
        plugins.push(
          dictionary({
            entries: payload.dictionaryEntries || [],
          })
        );
      }
      const hasEditorial = Object.keys(authored?.editorialRelationships || {}).length > 0;
      engine = SearchEngine.create({
        schema: payload.schema,
        plugins,
        lexicalIndex: payload.lexicalIndex,
        relationships: hasEditorial
          ? mergeEditorialRelationships(payload.relationships || null, authored!.editorialRelationships)
          : payload.relationships || null,
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
      const publicMeta = publicWorkerMeta(detailed.meta);
      reply({
        type: MSG.RESULT,
        requestId: message.requestId,
        payload: {
          results: detailed.results,
          related: detailed.related,
          meta: includeRetrievalDiagnostics
            ? { ...publicMeta, ...retrievalDiagnosticMeta(detailed.meta) }
            : publicMeta,
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
    includeRetrievalDiagnostics = false;
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
