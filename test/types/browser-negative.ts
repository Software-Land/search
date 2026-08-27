import { SearchEngine, type ExperimentalRetriever } from "@software-land/search";
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

// @ts-expect-error ProtocolMessage is not a public browser export
import type { ProtocolMessage } from "@software-land/search/browser";

// @ts-expect-error InitPayload is not a public browser export
import type { InitPayload } from "@software-land/search/browser";

// @ts-expect-error WorkerSearchPayload is not a public browser export
import type { WorkerSearchPayload } from "@software-land/search/browser";

// @ts-expect-error WorkerRuntime is not a public browser export
import type { WorkerRuntime } from "@software-land/search/browser";

const client = createSearchClient({ workerUrl: searchWorkerUrl() });
void client.init({
  documents: [],
  retriever: "indexed",
  englishOptions: { lemmas: {} },
});

// @ts-expect-error dictionaryEntries is not a public Worker init field
void client.init({ dictionaryEntries: [] });

// @ts-expect-error relationships is not a public Worker init field
void client.init({ relationships: null });

// @ts-expect-error internal pruning switch is not a public init field
void client.init({ _exactPruningMode: "exhaustive" });

// @ts-expect-error internal diagnostics switch is not a public init field
void client.init({ _includeRetrievalDiagnostics: true });

const customRetriever: ExperimentalRetriever = {
  retrieve() {
    return [];
  },
};
SearchEngine.create({ retriever: customRetriever });

void client.init({
  documents: [],
  // @ts-expect-error Worker init cannot accept a function-bearing custom retriever
  retriever: customRetriever,
});
