import crypto from "node:crypto";

/** @param {unknown} text */
export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/** @param {unknown} value */
export function hashJson(value) {
  return sha256Hex(JSON.stringify(value));
}

/**
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string} keyFn
 * @returns {T[]}
 */
export function stableSort(arr, keyFn) {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}
