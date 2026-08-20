import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";

// @ts-expect-error ProtocolMessage is not a public browser export
import type { ProtocolMessage } from "@software-land/search/browser";

// @ts-expect-error InitPayload is not a public browser export
import type { InitPayload } from "@software-land/search/browser";

// @ts-expect-error WorkerRuntime is not a public browser export
import type { WorkerRuntime } from "@software-land/search/browser";

const client = createSearchClient({ workerUrl: searchWorkerUrl() });
void client;
