import fs from "node:fs";
import { normalizePath, normalizeRef } from "./ids.js";
import type { DocIndex, RelDocument } from "../types.js";

export function loadDocuments(input: unknown): RelDocument[] {
  let raw: unknown = input;
  if (typeof input === "string") {
    raw = JSON.parse(fs.readFileSync(input, "utf8"));
  }
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const documents: unknown[] = Array.isArray(raw) ? raw : Array.isArray(rec?.documents) ? rec.documents : [];
  return documents
    .filter((d: unknown) => d && typeof d === "object" && ((d as { id?: unknown; title?: unknown }).id || (d as { title?: unknown }).title))
    .map((d: unknown) => {
      const rec = d as Record<string, unknown>;
      return {
        id: String(rec.id ?? rec.title),
        title: String(rec.title || ""),
        body: String(rec.body || rec.content || ""),
        metadata: rec.metadata && typeof rec.metadata === "object" ? (rec.metadata as Record<string, unknown>) : {},
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function indexDocuments(documents: RelDocument[]): DocIndex {
  const byId = new Map<string, RelDocument>();
  const byPath = new Map<string, RelDocument>();
  const bySlug = new Map<string, RelDocument>();
  for (const doc of documents) {
    byId.set(doc.id, doc);
    const path = normalizePath(doc.metadata?.path || "");
    if (path) byPath.set(path, doc);
    const slug = path.replace(/^\/|\/$/g, "");
    if (slug) bySlug.set(slug, doc);
    const dir = String(doc.metadata?.dir || "").toLowerCase();
    if (dir) bySlug.set(dir, doc);
  }
  return { documents, byId, byPath, bySlug };
}

export function resolveRef(ref: unknown, index: DocIndex): RelDocument | null {
  const raw = normalizeRef(ref);
  if (!raw) return null;
  if (index.byId.has(raw)) return index.byId.get(raw) ?? null;
  const path = normalizePath(raw);
  if (path && index.byPath.has(path)) return index.byPath.get(path) ?? null;
  const slug = raw.replace(/^\/|\/$/g, "").toLowerCase();
  if (slug && index.bySlug.has(slug)) return index.bySlug.get(slug) ?? null;
  return null;
}
