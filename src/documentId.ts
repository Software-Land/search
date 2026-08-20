/**
 * Canonical document ids for compile, attach, and SearchEngine.index.
 * Whitespace around an id is not a distinct document.
 */
export function canonicalDocumentId(value: unknown): string {
  return String(value ?? "").trim();
}
