import fs from "node:fs";
import type { CorpusDocument, LoadedCorpus } from "../types.js";

/**
 * Portable corpus: { documents: [{ id, title, body, metadata? }] }
 * or a bare array of documents.
 */
export function loadCorpus(input: unknown): LoadedCorpus {
  let raw: unknown = input;
  if (typeof input === "string") {
    raw = JSON.parse(fs.readFileSync(input, "utf8"));
  }
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const documents = Array.isArray(raw) ? raw : Array.isArray(rec?.documents) ? rec.documents : [];
  const docs: CorpusDocument[] = documents
    .filter((d: unknown) => d && typeof d === "object" && ((d as { id?: unknown; title?: unknown }).id || (d as { title?: unknown }).title))
    .map((d: Record<string, unknown>) => ({
      id: String(d.id ?? d.title),
      title: String(d.title || ""),
      body: String(d.body || d.content || ""),
      metadata: d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>) : {},
    }));
  docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    format: typeof rec?.format === "string" ? rec.format : "search-corpus-input",
    version: typeof rec?.version === "number" ? rec.version : 1,
    documents: docs,
  };
}
