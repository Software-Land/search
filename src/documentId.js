/**
 * Canonical document ids for compile, attach, and SearchEngine.index.
 * Whitespace around an id is not a distinct document.
 */
/** @param {unknown} value */
export function canonicalDocumentId(value) {
  return String(value ?? "").trim();
}
