import fs from "node:fs";

/**
 * Portable corpus: { documents: [{ id, title, body, metadata? }] }
 * or a bare array of documents. No Gatsby / V1 store types.
 * @param {unknown} input
 * @returns {import("../types.js").LoadedCorpus}
 */
export function loadCorpus(input) {
  let raw = input;
  if (typeof input === "string") {
    raw = JSON.parse(fs.readFileSync(input, "utf8"));
  }
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : null;
  const documents = Array.isArray(raw) ? raw : Array.isArray(rec?.documents) ? rec.documents : [];
  const docs = documents
    .filter((/** @type {unknown} */ d) => d && typeof d === "object" && (/** @type {{ id?: unknown, title?: unknown }} */ (d).id || /** @type {{ title?: unknown }} */ (d).title))
    .map((/** @type {Record<string, unknown>} */ d) => ({
      id: String(d.id ?? d.title),
      title: String(d.title || ""),
      body: String(d.body || d.content || ""),
      metadata: d.metadata && typeof d.metadata === "object" ? /** @type {Record<string, unknown>} */ (d.metadata) : {},
    }));
  docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    format: typeof rec?.format === "string" ? rec.format : "search-corpus-input",
    version: typeof rec?.version === "number" ? rec.version : 1,
    documents: docs,
  };
}
