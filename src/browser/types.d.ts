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
  lexicalIndex?: import("../index.js").LexicalIndexArtifact;
  configuredConcepts?: import("../index.js").ConfiguredConcept[];
  relationshipMap?: import("../index.js").RelationshipMap;
  documentRelationships?: import("../index.js").RelationshipArtifact | null;
  relationshipStrategy?: import("../index.js").RelationshipStrategy;
  retriever?: import("../index.js").SearchEngineOptions["retriever"];
  candidateLimit?: number | null;
  adaptive?: import("../index.js").AdaptiveOptions;
  englishOptions?: { lemmas?: Record<string, string> };
  /** Internal benchmark/reference switch; not part of the public facade. */
  _exactPruningMode?: "auto" | "exhaustive";
  /** Internal Worker diagnostic opt-in; not part of the public facade. */
  _includeRetrievalDiagnostics?: boolean;
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

export interface WorkerRetrievalDiagnosticMeta {
  representativeSelection?: Record<string, unknown> | null;
  postingEntriesVisited?: number | null;
  distinctDocumentsExamined?: number | null;
  rawDocumentScans?: number | null;
  postingBlocksVisited?: number;
  postingBlocksSkipped?: number;
  postingEntriesSkipped?: number;
  duplicatePostingEntriesAvoided?: number;
  queryFormsExpanded?: number;
  termsExpanded?: number;
  documentBlocksVisited?: number;
  documentBlocksSkipped?: number;
  boundedBlocksSkipped?: number;
  documentsFullyEvaluated?: number;
  documentsBoundRejected?: number;
  pruningSignaturesEncountered?: number;
  pruningRepresentativesRetained?: number;
  pruningFallbackReason?: string | null;
}

export interface WorkerSearchPayload {
  results?: unknown;
  related?: unknown;
  meta?: {
    totalMs?: number;
    retrieveMs?: number;
    featureMs?: number;
    selectionMs?: number;
    rankMs?: number;
    candidateCount?: number;
    matchCount?: number;
    relatedCount?: number;
    relationshipStrategy?: string;
  } & Partial<WorkerRetrievalDiagnosticMeta>;
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
  /** Full authored-relevance compiler. Takes precedence over `dictionary`. */
  compileAuthoredRelevance?: typeof import("../dictionary.js").compileAuthoredRelevance;
  /**
   * Legacy custom-host dictionary factory. Invoked only when init has no
   * `relationshipMap`. `relationshipMap` requires `compileAuthoredRelevance`.
   */
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
