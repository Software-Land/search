import {
  MSG,
  PROTOCOL_VERSION,
  createLatestWinsSession,
  createLoopbackTransport,
  createSearchClient,
  createWorkerRuntime,
  searchWorkerUrl,
  type SearchClient,
  type SearchClientOptions,
} from "@software-land/search/browser";

const workerUrl: URL = searchWorkerUrl();
void workerUrl.href;

const options: SearchClientOptions = {
  workerUrl,
  onResult: ({ query, generation }) => {
    void query;
    void generation;
  },
  onClear: ({ generation }) => {
    void generation;
  },
  onError: ({ error }) => {
    void error;
  },
  onReady: (msg) => {
    void msg;
  },
};

const client: SearchClient = createSearchClient(options);
void client.init;
void client.setQuery;
void client.dispose;
void client.terminate;
void client.waitReady;
void client.stats;
void client.currentGeneration;
void client.timings;
void client.ready;

const session: unknown = createLatestWinsSession({});
const runtime: unknown = createWorkerRuntime({});
const transport: unknown = createLoopbackTransport(runtime);
void session;
void transport;
void MSG.SEARCH;
void PROTOCOL_VERSION;
