import { tokenize, firstSurfaceToken, DEFAULT_STOP } from "./text.js";
import { canonicalDocumentId } from "./documentId.js";
import { extractVersionCompactForms, extractDottedSpans } from "./versionForms.js";
import { InvalidDocumentError } from "./errors.js";

/** @param {import("./types.js").Schema | null | undefined} schema @param {string} name */
function fieldRole(schema, name) {
  const spec = schema?.[name];
  if (!spec) return null;
  return spec.role || (name === "title" ? "title" : name === "body" ? "body" : null);
}

/** @param {import("./types.js").Schema | null | undefined} [schema] @returns {import("./types.js").ResolvedSchema} */
export function resolveSchema(schema) {
  /** @type {import("./types.js").Schema} */
  const fields =
    schema && typeof schema === "object"
      ? schema
      : { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
  let titleField = null;
  let bodyField = null;
  const textFields = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || spec.type !== "text") continue;
    textFields.push(name);
    const role = fieldRole(fields, name);
    if (role === "title" && !titleField) titleField = name;
    if (role === "body" && !bodyField) bodyField = name;
  }
  if (!titleField) titleField = textFields[0] || "title";
  if (!bodyField) bodyField = textFields.find((n) => n !== titleField) || titleField;
  return { fields, titleField, bodyField };
}

/** @param {import("./types.js").SearchDocument} doc @param {string} id @param {string} title @param {string} body */
function copyRaw(doc, id, title, body) {
  const metadata = doc && doc.metadata != null && typeof doc.metadata === "object" && !Array.isArray(doc.metadata) ? { ...doc.metadata } : undefined;
  return metadata ? { id, title, body, metadata } : { id, title, body };
}

/**
 * Canonical 0.2.0 shapes produced by attachLexicalFrequency / SearchEngine:
 *   1. flat Record<string, number>  (preferred; attachLexicalFrequency writes this)
 *   2. { ngrams: Record<string, number> }
 * `ngrams` wins when it is a non-array object. Arrays are rejected.
 * @param {unknown} raw @returns {Record<string, number> | null}
 */
function copyLexicalFrequency(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const nested = rec.ngrams;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? /** @type {Record<string, unknown>} */ (nested)
      : rec;
  /** @type {Record<string, number>} */
  const out = Object.create(null);
  let any = false;
  for (const [key, value] of Object.entries(source)) {
    if (key === "ngrams") continue;
    const n = Number(value);
    if (!key || !Number.isFinite(n) || n <= 0) continue;
    out[key] = n;
    any = true;
  }
  return any ? out : null;
}

/**
 * @param {unknown} doc
 * @param {import("./types.js").Schema | null | undefined} schema
 * @param {{ lemma?: (t: string) => string, index?: number | null }} [opts]
 * @returns {import("./types.js").IndexedDocument}
 */
export function analyzeDocument(doc, schema, { lemma = (t) => t, index = null } = {}) {
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvalidDocumentError("Each document must be a plain object", { index, field: "document" });
  }
  const rec = /** @type {import("./types.js").SearchDocument} */ (doc);
  const { titleField, bodyField } = resolveSchema(schema);
  const id = canonicalDocumentId(rec.id);
  if (!id) {
    throw new InvalidDocumentError("Each document must have a non-empty string id", { index, field: "id" });
  }
  const title = rec[titleField] == null && rec.title == null ? "" : String(rec[titleField] ?? rec.title ?? "");
  const body = rec[bodyField] == null && rec.body == null ? "" : String(rec[bodyField] ?? rec.body ?? "");
  const titleTokens = tokenize(title);
  const bodyTokens = tokenize(body);
  const titleLemmas = titleTokens.map(lemma);
  const bodyLemmas = bodyTokens.map(lemma);
  const nonStopTitle = titleTokens.filter((t) => !DEFAULT_STOP.has(t));
  return {
    id,
    raw: copyRaw(rec, id, title, body),
    title,
    body,
    titleTokens,
    bodyTokens,
    titleLemmas,
    bodyLemmas,
    titleLemmaSet: new Set(titleLemmas),
    bodyLemmaSet: new Set(bodyLemmas),
    titleTokenSet: new Set(titleTokens),
    bodyTokenSet: new Set(bodyTokens),
    nonStopTitle,
    firstToken: firstSurfaceToken(title),
    normalizedTitle: titleTokens.join(" "),
    versionCompactForms: extractVersionCompactForms(title),
    dottedSpans: extractDottedSpans(title),
    lexicalFrequency: copyLexicalFrequency(rec.lexicalFrequency),
  };
}

/**
 * Rebuilds the in-memory index. Duplicate ids: last document wins.
 * Documents are sorted by id for deterministic iteration.
 * @param {unknown[] | null | undefined} documents
 * @param {import("./types.js").Schema | null | undefined} schema
 * @param {import("./types.js").SearchPlugin[]} [plugins]
 * @returns {import("./types.js").SearchIndex}
 */
export function buildIndex(documents, schema, plugins = []) {
  if (documents != null && !Array.isArray(documents)) {
    throw new InvalidDocumentError("index(documents) requires an array", { field: "documents" });
  }
  const lemmaFn = plugins.find((p) => typeof p.lemma === "function")?.lemma || ((t) => t);
  const byId = new Map();
  const docsIn = documents || [];
  for (let i = 0; i < docsIn.length; i++) {
    const analyzed = analyzeDocument(docsIn[i], schema, { lemma: lemmaFn, index: i });
    byId.set(analyzed.id, analyzed);
  }
  const docs = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const titleTokenSet = new Set();
  const surfaceVocabulary = new Set();
  for (const analyzed of docs) {
    for (const t of analyzed.titleTokens) {
      titleTokenSet.add(t);
      surfaceVocabulary.add(t);
    }
    for (const t of analyzed.titleLemmas) titleTokenSet.add(t);
    for (const t of analyzed.bodyTokens) surfaceVocabulary.add(t);
  }
  return { schema: resolveSchema(schema), documents: docs, byId, titleTokenSet, surfaceVocabulary };
}
