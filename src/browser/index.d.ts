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
  init(payload: Record<string, unknown>): Promise<unknown>;
  setQuery(query: string, options?: Record<string, unknown>): void;
  dispose(): void;
  terminate(): void;
  waitReady(): Promise<void>;
  stats(): Record<string, number>;
  currentGeneration(): number;
  timings(): Record<string, number>;
  readonly ready: boolean;
}

export declare function createSearchClient(options?: SearchClientOptions): SearchClient;
/** Resolves the bundled Worker module URL from this package. */
export declare function searchWorkerUrl(): URL;
export declare function createLatestWinsSession(options: unknown): unknown;
export declare function createWorkerRuntime(options: unknown): unknown;
export declare function createLoopbackTransport(runtime: unknown): unknown;
export declare const PROTOCOL_VERSION: 1;
export declare const MSG: {
  readonly INIT: "init";
  readonly SEARCH: "search";
  readonly CANCEL: "cancel";
  readonly DISPOSE: "dispose";
  readonly READY: "ready";
  readonly RESULT: "result";
  readonly ERROR: "error";
  readonly ABORTED: "aborted";
};
