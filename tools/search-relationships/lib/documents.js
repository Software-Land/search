import fs from "node:fs";
import { normalizePath, normalizeRef } from "./ids.js";

/** @param {unknown} input @returns {import("../types.js").RelDocument[]} */
export function loadDocuments(input) {
  let raw = input;
  if (typeof input === "string") {
    raw = JSON.parse(fs.readFileSync(input, "utf8"));
  }
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : null;
  const documents = Array.isArray(raw) ? raw : Array.isArray(rec?.documents) ? rec.documents : [];
  return documents
    .filter((/** @type {unknown} */ d) => d && typeof d === "object" && (/** @type {{ id?: unknown, title?: unknown }} */ (d).id || /** @type {{ title?: unknown }} */ (d).title))
    .map((/** @type {Record<string, unknown>} */ d) => ({
      id: String(d.id ?? d.title),
      title: String(d.title || ""),
      body: String(d.body || d.content || ""),
      metadata: d.metadata && typeof d.metadata === "object" ? /** @type {Record<string, unknown>} */ (d.metadata) : {},
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** @param {import("../types.js").RelDocument[]} documents @returns {import("../types.js").DocIndex} */
export function indexDocuments(documents) {
  const byId = new Map();
  const byPath = new Map();
  const bySlug = new Map();
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

/** @param {unknown} ref @param {import("../types.js").DocIndex} index @returns {import("../types.js").RelDocument | null} */
export function resolveRef(ref, index) {
  const raw = normalizeRef(ref);
  if (!raw) return null;
  if (index.byId.has(raw)) return index.byId.get(raw) ?? null;
  const path = normalizePath(raw);
  if (path && index.byPath.has(path)) return index.byPath.get(path) ?? null;
  const slug = raw.replace(/^\/|\/$/g, "").toLowerCase();
  if (slug && index.bySlug.has(slug)) return index.bySlug.get(slug) ?? null;
  return null;
}
