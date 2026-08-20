/**
 * Browser Worker entry. Keep this file thin so SearchEngine never imports Worker.
 */
/* eslint-disable no-restricted-globals */
import { SearchEngine, english, dictionary } from "../index.js";
import { createWorkerRuntime } from "./workerRuntime.js";

const runtime = createWorkerRuntime({
  SearchEngine: /** @type {typeof import("../SearchEngine.js").SearchEngine} */ (SearchEngine),
  english: /** @type {typeof import("../english.js").english} */ (english),
  dictionary: /** @type {typeof import("../dictionary.js").dictionary} */ (dictionary),
});

self.onmessage = (/** @type {MessageEvent} */ ev) => {
  runtime.dispatch(ev.data, (/** @type {import("./types.js").ProtocolMessage} */ msg) => self.postMessage(msg));
};
