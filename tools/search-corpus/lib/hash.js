import crypto from "node:crypto";

/** @param {unknown} text */
export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/** @param {unknown} value */
export function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

/** @param {unknown} value */
export function hashJson(value) {
  return sha256Hex(JSON.stringify(value));
}
