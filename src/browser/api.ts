/**
 * Designed public type contract for @software-land/search/browser.
 * Protocol/runtime implementation types stay internal.
 */

import type {
  AdaptiveOptions,
  ConfiguredConcept,
  LexicalIndexArtifact,
  RelationshipArtifact,
  RelationshipStrategy,
  RetrieverName,
  Schema,
  SearchDocument,
} from "../api.js";

interface InitPayload {
  documents?: SearchDocument[];
  schema?: Schema;
  lexicalIndex?: LexicalIndexArtifact;
  configuredConcepts?: ConfiguredConcept[];
  relationshipMap?: import("../api.js").RelationshipMap;
  documentRelationships?: RelationshipArtifact | null;
  relationshipStrategy?: RelationshipStrategy;
  /** Worker-safe retriever name. Function-bearing custom retrievers are not structured-cloneable. */
  retriever?: RetrieverName | "indexed-lexical";
  candidateLimit?: number | null;
  adaptive?: AdaptiveOptions;
  englishOptions?: { lemmas?: Record<string, string> };
}

export interface SearchClientOptions {
  worker?: { postMessage(msg: unknown): void; addEventListener?: Function; terminate?: Function; subscribe?: Function };
  workerUrl?: URL | string;
  workerFactory?: (url: URL | string, options?: unknown) => unknown;
  workerOptions?: unknown;
  onResult?: (payload: { query: string; result: unknown; generation: number }) => void;
  onClear?: (payload: { generation: number; query: string }) => void;
  onError?: (payload: { generation: number; query: string; error: unknown }) => void;
  onReady?: (msg: unknown) => void;
}

export interface SearchClient {
  init(payload: InitPayload): Promise<unknown>;
  setQuery(query: string, options?: Record<string, unknown>): void;
  dispose(): void;
  terminate(): void;
  waitReady(): Promise<void>;
  stats(): Record<string, number>;
  currentGeneration(): number;
  timings(): Record<string, number>;
  readonly ready: boolean;
}
