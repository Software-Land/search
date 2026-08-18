/**
 * Cooperative cancellation. AbortSignal is the cross-platform contract.
 * A cancelled search throws; it never returns []. That distinguishes
 * "no hits" from "this query is stale."
 */

/** @param {string} [message] @returns {Error} */
export function abortError(message = "Aborted") {
  if (typeof DOMException === "function") {
    try {
      return new DOMException(message, "AbortError");
    } catch {
      // some environments construct DOMException differently
    }
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/** @param {AbortSignal | null | undefined} [signal] */
export function throwIfAborted(signal) {
  if (!signal) return;
  if (signal.aborted) throw abortError("Aborted");
}

/** @param {unknown} err */
export function isAbortError(err) {
  if (!err || typeof err !== "object") return false;
  const rec = /** @type {{ name?: unknown, code?: unknown }} */ (err);
  return rec.name === "AbortError" || rec.code === 20;
}
