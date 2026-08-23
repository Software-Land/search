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

// @ts-expect-error internal pruning switch is not a public init field
void client.init({ _exactPruningMode: "exhaustive" });

// @ts-expect-error internal diagnostics switch is not a public init field
void client.init({ _includeRetrievalDiagnostics: true });
