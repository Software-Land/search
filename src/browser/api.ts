/**
 * Designed public type contract for @software-land/search/browser.
 * Protocol/runtime implementation types stay internal.
 */

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
