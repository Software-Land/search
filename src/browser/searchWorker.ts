/**
 * Browser Worker entry. Keep this file thin so SearchEngine never imports Worker.
 */
/* eslint-disable no-restricted-globals */
import { SearchEngine, english, dictionary } from "../index.js";
import { createWorkerRuntime } from "./workerRuntime.js";
import type { WorkerRuntimeFactories } from "./types.js";

const runtime = createWorkerRuntime({
  SearchEngine,
  english,
  dictionary,
} as WorkerRuntimeFactories);

self.onmessage = (ev) => {
  runtime.dispatch(ev.data, (msg) => self.postMessage(msg));
};
