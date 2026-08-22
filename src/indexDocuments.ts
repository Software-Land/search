import { tokenize, firstSurfaceToken, DEFAULT_STOP } from "./text.js";
import { canonicalDocumentId } from "./documentId.js";
import { extractVersionCompactForms, extractDottedSpans, dottedSpanComponentIndexes } from "./versionForms.js";
import { InvalidDocumentError } from "./errors.js";
import type {
  IndexedDocument,
  ResolvedSchema,
  Schema,
  SearchDocument,
  SearchIndex,
  SearchPlugin,
} from "./types.js";

function fieldRole(schema: Schema | null | undefined, name: string) {
  const spec = schema?.[name];
  if (!spec) return null;
  return spec.role || (name === "title" ? "title" : name === "body" ? "body" : null);
}

export function resolveSchema(schema?: Schema | null): ResolvedSchema {
  const fields: Schema =
    schema && typeof schema === "object"
      ? schema
      : { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
  let titleField: string | null = null;
  let bodyField: string | null = null;
  const textFields: string[] = [];
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

function copyRaw(doc: SearchDocument, id: string, title: string, body: string) {
  const metadata = doc && doc.metadata != null && typeof doc.metadata === "object" && !Array.isArray(doc.metadata) ? { ...doc.metadata } : undefined;
  return metadata ? { id, title, body, metadata } : { id, title, body };
}

/**
 * Canonical 0.2.0 shapes produced by attachLexicalFrequency / SearchEngine:
 *   1. flat Record<string, number>  (preferred; attachLexicalFrequency writes this)
 *   2. { ngrams: Record<string, number> }
 * `ngrams` wins when it is a non-array object. Arrays are rejected.
 */
function copyLexicalFrequency(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const nested = rec.ngrams;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : rec;
  const out: Record<string, number> = Object.create(null);
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

function independentTitleList(tokens: string[], marked: Set<number>) {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!marked.has(i) && tokens[i]) out.push(tokens[i]);
  }
  return out;
}

function independentTitleSet(tokens: string[]) {
  return new Set(tokens);
}

function tokenPositionIndex(tokens: string[]) {
  const map = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const arr = map.get(tok);
    if (arr) arr.push(i);
    else map.set(tok, [i]);
  }
  return map;
}

export function analyzeDocument(
  doc: unknown,
  schema: Schema | null | undefined,
  { lemma = (t: string) => t, index = null }: { lemma?: (t: string) => string; index?: number | null } = {}
): IndexedDocument {
  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvalidDocumentError("Each document must be a plain object", { index, field: "document" });
  }
  const rec = doc as SearchDocument;
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
  const spanIndexes = dottedSpanComponentIndexes(title);
  const independentTitleTokens = independentTitleList(titleTokens, spanIndexes);
  const independentTitleLemmas = independentTitleList(titleLemmas, spanIndexes);
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
    dottedSpanComponentIndexes: spanIndexes,
    independentTitleTokens,
    independentTitleTokenSet: independentTitleSet(independentTitleTokens),
    independentTitleLemmaSet: independentTitleSet(independentTitleLemmas),
    bodyTokenPositions: tokenPositionIndex(bodyTokens),
    bodyLemmaPositions: tokenPositionIndex(bodyLemmas),
    lexicalFrequency: copyLexicalFrequency(rec.lexicalFrequency),
  };
}

/**
 * Rebuilds the in-memory index. Duplicate ids: last document wins.
 * Documents are sorted by id for deterministic iteration.
 */
export function buildIndex(
  documents: unknown[] | null | undefined,
  schema: Schema | null | undefined,
  plugins: SearchPlugin[] = []
): SearchIndex {
  if (documents != null && !Array.isArray(documents)) {
    throw new InvalidDocumentError("index(documents) requires an array", { field: "documents" });
  }
  const lemmaFn = plugins.find((p) => typeof p.lemma === "function")?.lemma || ((t: string) => t);
  const byId = new Map<string, IndexedDocument>();
  const docsIn = documents || [];
  for (let i = 0; i < docsIn.length; i++) {
    const analyzed = analyzeDocument(docsIn[i], schema, { lemma: lemmaFn, index: i });
    byId.set(analyzed.id, analyzed);
  }
  const docs = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const titleTokenSet = new Set<string>();
  const surfaceVocabulary = new Set<string>();
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
