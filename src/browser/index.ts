import { createSearchClient as createSearchClientImpl, searchWorkerUrl as searchWorkerUrlImpl } from "./searchClient.js";
import { createLatestWinsSession as createLatestWinsSessionImpl } from "./latestWins.js";
import { createWorkerRuntime as createWorkerRuntimeImpl, createLoopbackTransport as createLoopbackTransportImpl } from "./workerRuntime.js";
import { MSG as msgImpl, PROTOCOL_VERSION as protocolVersionImpl } from "./protocol.js";
import type { SearchClient, SearchClientOptions } from "./api.js";

export type { SearchClient, SearchClientOptions } from "./api.js";

export const createSearchClient: (options?: SearchClientOptions) => SearchClient =
  createSearchClientImpl as (options?: SearchClientOptions) => SearchClient;
/** Resolves the bundled Worker module URL from this package. */
export const searchWorkerUrl: () => URL = searchWorkerUrlImpl;
export const createLatestWinsSession: (options: unknown) => unknown =
  createLatestWinsSessionImpl as (options: unknown) => unknown;
export const createWorkerRuntime: (options: unknown) => unknown =
  createWorkerRuntimeImpl as (options: unknown) => unknown;
export const createLoopbackTransport: (runtime: unknown) => unknown =
  createLoopbackTransportImpl as (runtime: unknown) => unknown;
export const PROTOCOL_VERSION: 1 = protocolVersionImpl;
export const MSG: {
  readonly INIT: "init";
  readonly SEARCH: "search";
  readonly CANCEL: "cancel";
  readonly DISPOSE: "dispose";
  readonly READY: "ready";
  readonly RESULT: "result";
  readonly ERROR: "error";
  readonly ABORTED: "aborted";
} = msgImpl;
