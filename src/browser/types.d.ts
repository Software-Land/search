/**
 * Internal browser/Worker contracts for checkJs.
 * Public facade types live in api.ts / index.ts.
 */

export type ProtocolType =
  | "init"
  | "search"
  | "cancel"
  | "dispose"
  | "ready"
  | "result"
  | "error"
  | "aborted";

export interface InitPayload {
  documents?: import("../index.js").SearchDocument[];
  schema?: import("../index.js").Schema;
  dictionaryEntries?: import("../index.js").EquivalenceEntry[];
  relationships?: import("../index.js").RelationshipArtifact | null;
  relationshipStrategy?: import("../index.js").RelationshipStrategy;
  retriever?: import("../index.js").SearchEngineOptions["retriever"];
  candidateLimit?: number | null;
  adaptive?: import("../index.js").AdaptiveOptions;
  englishOptions?: { lemmas?: Record<string, string> };
}

export interface ProtocolMessage {
  type: ProtocolType | string;
  requestId?: number;
  query?: unknown;
  options?: Record<string, unknown>;
  payload?: InitPayload | WorkerSearchPayload | Record<string, unknown>;
  error?: { name?: string; message?: string };
  documentCount?: number;
  [key: string]: unknown;
}

export interface WorkerSearchPayload {
  results?: unknown;
  related?: unknown;
  meta?: {
    totalMs?: number;
    retrieveMs?: number;
    rankMs?: number;
    candidateCount?: number;
    relationshipStrategy?: string;
    relatedCount?: number;
  };
}

export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener?: (type: string, listener: (ev: { data: unknown }) => void) => void;
  onmessage?: ((ev: { data: unknown }) => void) | null;
  terminate?: () => void;
  subscribe?: (fn: (data: unknown) => void) => () => void;
}

export interface ResultPayload {
  generation: number;
  query: string;
  result: unknown;
}

export interface ClearPayload {
  generation: number;
  query: string;
}

export interface ErrorPayload {
  generation: number;
  query: string;
  error: unknown;
}

export interface LatestWinsOptions {
  search?: (query: string, options?: Record<string, unknown> & { signal?: AbortSignal; generation?: number }) => Promise<unknown>;
  onResult?: (payload: ResultPayload) => void;
  onClear?: (payload: ClearPayload) => void;
  onError?: (payload: ErrorPayload) => void;
}

export interface PendingJob {
  query: string;
  options: Record<string, unknown>;
  generation: number;
}

export interface RunningJob {
  generation: number;
  abort(): void;
}

export interface SearchClientOptions {
  worker?: WorkerLike | null;
  workerUrl?: URL | string;
  workerFactory?: (url: URL | string, options?: unknown) => WorkerLike;
  workerOptions?: unknown;
  onResult?: (payload: ResultPayload) => void;
  onClear?: (payload: ClearPayload) => void;
  onError?: (payload: ErrorPayload) => void;
  onReady?: (msg: unknown) => void;
}

export interface WorkerRuntimeFactories {
  SearchEngine?: typeof import("../SearchEngine.js").SearchEngine;
  english?: typeof import("../english.js").english;
  dictionary?: typeof import("../dictionary.js").dictionary;
}

export interface EngineLike {
  index(documents: unknown[]): Promise<{ documentCount: number }>;
  searchDetailedAsync(query: unknown, options?: unknown): Promise<{
    results: unknown;
    related: unknown;
    meta?: Record<string, unknown>;
  }>;
}

export type ReplyFn = (msg: ProtocolMessage) => void;

export interface WorkerRuntime {
  dispatch(message: ProtocolMessage | null | undefined, reply: ReplyFn): Promise<void> | void;
  readonly initialized: boolean;
}
