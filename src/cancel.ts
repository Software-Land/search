/**
 * Cooperative cancellation. AbortSignal is the cross-platform contract.
 * A cancelled search throws; it never returns []. That distinguishes
 * "no hits" from "this query is stale."
 */

export function abortError(message = "Aborted"): Error {
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

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal) return;
  if (signal.aborted) throw abortError("Aborted");
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: unknown; code?: unknown };
  return rec.name === "AbortError" || rec.code === 20;
}
