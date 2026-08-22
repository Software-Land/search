/**
 * search-v2-lexical-index v1
 *
 * The serialized payload stores one positional posting row per normalized
 * surface term. Each surface term carries its deterministic lemma, so lemma
 * postings are reconstructed as an inverse term mapping rather than duplicated
 * in the artifact. Raw body text is deliberately absent.
 */

import { assertArtifact } from "./artifacts.js";
import { canonicalDocumentId } from "./documentId.js";
import { ArtifactValidationError } from "./errors.js";
import { buildIndex, resolveSchema } from "./indexDocuments.js";
import { stableFingerprint } from "./stableHash.js";
import { DEFAULT_STOP, firstSurfaceToken } from "./text.js";
import type {
  IndexedDocument,
  LexicalIndexArtifact,
  Schema,
  SearchDocument,
  SearchIndex,
  SearchPlugin,
} from "./types.js";

export const LEXICAL_INDEX_FORMAT = "search-v2-lexical-index" as const;
export const LEXICAL_INDEX_VERSION = 1 as const;
export const CORE_ANALYZER_COMPATIBILITY = "search-v2-core-analyzer-v1";
export const IDENTITY_LEMMA_COMPATIBILITY = "identity-lemma-v1";

// Document tuple:
// [id, title, titleTokenLength, bodyTokenLength, firstSurfaceToken,
//  normalizedTitle, versionCompactForms, dottedSpans,
//  dottedSpanComponentIndexes]
type SerializedDocument = [
  string,
  string,
  number,
  number,
  string,
  string,
  string[],
  string[],
  number[],
];

// Term tuple: [surfaceTerm, lemma, titleFlatPostings, bodyFlatPostings].
// One flat posting is [documentIndex, positionCount, ...positions].
type SerializedTerm = [string, string, number[], number[]];

type LexicalIndexPayload = {
  documents: SerializedDocument[];
  terms: SerializedTerm[];
  stats: [number, number];
};

export type CompiledTermRuntime = {
  term: string;
  lemma: string;
  title: number[];
  body: number[];
  titleDf: number;
  bodyDf: number;
};

export type CompiledLexicalRuntime = {
  terms: CompiledTermRuntime[];
  bySurface: Map<string, CompiledTermRuntime>;
  byLemma: Map<string, CompiledTermRuntime[]>;
  sortedTerms: string[];
  sortedTitles: Array<{ norm: string; pos: number }>;
  titleByNorm: Map<string, number[]>;
  versionIndex: Map<string, number[]>;
  titleDl: number[];
  bodyDl: number[];
  avgTitleDl: number;
  avgBodyDl: number;
  postingEntries: number;
};

function fail(message: string, field: string): never {
  throw new ArtifactValidationError(message, { format: LEXICAL_INDEX_FORMAT, field });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finitePositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function sortedNumberRecord(value: unknown): Record<string, number> | null {
  if (!plainRecord(value)) return null;
  const nested = plainRecord(value.ngrams) ? value.ngrams : value;
  const out: Record<string, number> = {};
  for (const key of Object.keys(nested).sort()) {
    if (key === "ngrams") continue;
    const n = Number(nested[key]);
    if (!key || !Number.isFinite(n) || n <= 0) continue;
    out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

function inputDocuments(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (plainRecord(input) && Array.isArray(input.documents)) return input.documents;
  return [];
}

function sourceRows(documents: unknown, schema?: Schema | null) {
  const { titleField, bodyField } = resolveSchema(schema);
  const byId = new Map<string, [string, string, string, Record<string, number> | null]>();
  const rows = inputDocuments(documents);
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i];
    if (!plainRecord(value)) {
      fail(`Lexical index source document ${i} must be a plain object`, `documents[${i}]`);
    }
    const doc = value as SearchDocument;
    const id = canonicalDocumentId(doc.id);
    if (!id) fail(`Lexical index source document ${i} requires a non-empty id`, `documents[${i}].id`);
    const title = doc[titleField] == null && doc.title == null ? "" : String(doc[titleField] ?? doc.title ?? "");
    const body = doc[bodyField] == null && doc.body == null ? "" : String(doc[bodyField] ?? doc.body ?? "");
    byId.set(id, [id, title, body, sortedNumberRecord(doc.lexicalFrequency)]);
  }
  return [...byId.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function lexicalCorpusFingerprint(documents: unknown, schema?: Schema | null) {
  return stableFingerprint(sourceRows(documents, schema));
}

function indexedCorpusFingerprint(index: SearchIndex) {
  return stableFingerprint(
    index.documents.map((doc) => [doc.id, doc.title, doc.body, sortedNumberRecord(doc.lexicalFrequency)])
  );
}

export function lexicalAnalyzerIdentity(
  plugins: SearchPlugin[] = [],
  { requireIdentified = false }: { requireIdentified?: boolean } = {}
) {
  const plugin = plugins.find((item) => typeof item.lemma === "function");
  if (!plugin) return IDENTITY_LEMMA_COMPATIBILITY;
  if (typeof plugin.indexIdentity === "string" && plugin.indexIdentity) return plugin.indexIdentity;
  if (requireIdentified) {
    fail(
      "A supplied lexical index requires the active lemma plugin to expose a deterministic indexIdentity",
      "compatibility.analyzer"
    );
  }
  return `runtime-unidentified:${plugin.name || "custom"}`;
}

function postingRows(tokens: string[], lemmas: string[], docPos: number, field: 2 | 3, terms: Map<string, SerializedTerm>) {
  const positions = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const term = tokens[i];
    if (!term) continue;
    const current = positions.get(term);
    if (current) current.push(i);
    else positions.set(term, [i]);
  }
  for (const [term, pos] of positions) {
    const first = pos[0];
    const lemma = lemmas[first] || term;
    let row = terms.get(term);
    if (!row) {
      row = [term, lemma, [], []];
      terms.set(term, row);
    } else if (row[1] !== lemma) {
      fail(`Lemma plugin returned inconsistent values for surface term ${JSON.stringify(term)}`, "data.terms");
    }
    const flat = row[field];
    flat.push(docPos, pos.length, ...pos);
  }
}

function serializeDocuments(index: SearchIndex): SerializedDocument[] {
  return index.documents.map((doc) => [
    doc.id,
    doc.title,
    doc.titleTokens.length,
    doc.bodyTokens.length,
    doc.firstToken,
    doc.normalizedTitle,
    [...doc.versionCompactForms],
    [...doc.dottedSpans],
    [...doc.dottedSpanComponentIndexes].sort((a, b) => a - b),
  ]);
}

function buildPayload(index: SearchIndex): LexicalIndexPayload {
  const terms = new Map<string, SerializedTerm>();
  let titleLength = 0;
  let bodyLength = 0;
  for (let i = 0; i < index.documents.length; i++) {
    const doc = index.documents[i];
    postingRows(doc.titleTokens, doc.titleLemmas, i, 2, terms);
    postingRows(doc.bodyTokens, doc.bodyLemmas, i, 3, terms);
    titleLength += doc.titleTokens.length;
    bodyLength += doc.bodyTokens.length;
  }
  const sortedTerms = [...terms.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const n = index.documents.length;
  return {
    documents: serializeDocuments(index),
    terms: sortedTerms,
    stats: [n ? titleLength / n : 1, n ? bodyLength / n : 1],
  };
}

function envelope(
  payload: LexicalIndexPayload,
  index: SearchIndex,
  analyzer: string
): LexicalIndexArtifact {
  const compatibility: LexicalIndexArtifact["compatibility"] = {
    core: CORE_ANALYZER_COMPATIBILITY,
    analyzer,
    schema: [index.schema.titleField, index.schema.bodyField],
  };
  const corpus: LexicalIndexArtifact["corpus"] = {
    documentCount: index.documents.length,
    fingerprint: indexedCorpusFingerprint(index),
  };
  return {
    format: LEXICAL_INDEX_FORMAT,
    version: LEXICAL_INDEX_VERSION,
    compatibility,
    corpus,
    integrity: stableFingerprint({ compatibility, corpus, data: payload }),
    data: payload,
  };
}

export function compileLexicalIndexFromSearchIndex(
  index: SearchIndex,
  { analyzer = IDENTITY_LEMMA_COMPATIBILITY }: { analyzer?: string } = {}
) {
  const payload = buildPayload(index);
  const artifact = envelope(payload, index, analyzer);
  const runtime = runtimeFromPayload(payload);
  index.compiledLexical = runtime;
  index.lexicalArtifact = artifact;
  return { artifact, runtime };
}

export function compileLexicalIndex(
  documents: unknown,
  {
    schema,
    plugins = [],
    analyzer,
  }: { schema?: Schema | null; plugins?: SearchPlugin[]; analyzer?: string } = {}
): LexicalIndexArtifact {
  const index = buildIndex(inputDocuments(documents), schema, plugins);
  const identity = analyzer || lexicalAnalyzerIdentity(plugins, { requireIdentified: plugins.some((p) => typeof p.lemma === "function") });
  return compileLexicalIndexFromSearchIndex(index, { analyzer: identity }).artifact;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${field} must be an array of strings`, field);
  }
  return value.slice() as string[];
}

function requireNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !finitePositiveInteger(item))) {
    fail(`${field} must be an array of non-negative integers`, field);
  }
  return value.slice() as number[];
}

function parseDocument(value: unknown, i: number): SerializedDocument {
  const field = `data.documents[${i}]`;
  if (!Array.isArray(value) || value.length !== 9) fail(`${field} must be a 9-value document tuple`, field);
  const [id, title, titleLength, bodyLength, first, normalized, versions, spans, marked] = value;
  if (typeof id !== "string" || !id) fail(`${field}[0] must be a non-empty id`, `${field}[0]`);
  if (typeof title !== "string") fail(`${field}[1] must be a title string`, `${field}[1]`);
  if (!finitePositiveInteger(titleLength)) fail(`${field}[2] must be a token length`, `${field}[2]`);
  if (!finitePositiveInteger(bodyLength)) fail(`${field}[3] must be a token length`, `${field}[3]`);
  if (typeof first !== "string") fail(`${field}[4] must be a first-token string`, `${field}[4]`);
  if (typeof normalized !== "string") fail(`${field}[5] must be a normalized title`, `${field}[5]`);
  return [
    id,
    title,
    titleLength,
    bodyLength,
    first,
    normalized,
    requireStringArray(versions, `${field}[6]`),
    requireStringArray(spans, `${field}[7]`),
    requireNumberArray(marked, `${field}[8]`),
  ];
}

function parseTerm(value: unknown, i: number): SerializedTerm {
  const field = `data.terms[${i}]`;
  if (!Array.isArray(value) || value.length !== 4) fail(`${field} must be a 4-value term tuple`, field);
  const [term, lemma, title, body] = value;
  if (typeof term !== "string" || !term) fail(`${field}[0] must be a non-empty term`, `${field}[0]`);
  if (typeof lemma !== "string" || !lemma) fail(`${field}[1] must be a non-empty lemma`, `${field}[1]`);
  return [
    term,
    lemma,
    requireNumberArray(title, `${field}[2]`),
    requireNumberArray(body, `${field}[3]`),
  ];
}

function parsePayload(value: unknown): LexicalIndexPayload {
  if (!plainRecord(value)) fail("Lexical index data must be a plain object", "data");
  if (!Array.isArray(value.documents)) fail("Lexical index data.documents must be an array", "data.documents");
  if (!Array.isArray(value.terms)) fail("Lexical index data.terms must be an array", "data.terms");
  if (!Array.isArray(value.stats) || value.stats.length !== 2 || value.stats.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
    fail("Lexical index data.stats must be [avgTitleLength, avgBodyLength]", "data.stats");
  }
  const documents = value.documents.map(parseDocument);
  const terms = value.terms.map(parseTerm);
  for (let i = 1; i < documents.length; i++) {
    if (documents[i - 1][0] >= documents[i][0]) fail("Lexical index documents must have unique, sorted ids", "data.documents");
  }
  for (let i = 1; i < terms.length; i++) {
    if (terms[i - 1][0] >= terms[i][0]) fail("Lexical index terms must be unique and sorted", "data.terms");
  }
  return { documents, terms, stats: [Number(value.stats[0]), Number(value.stats[1])] };
}

function decodeField(
  flat: number[],
  term: string,
  docs: Array<Array<string | undefined>>,
  field: string
) {
  let cursor = 0;
  let previousDoc = -1;
  let rows = 0;
  while (cursor < flat.length) {
    if (cursor + 2 > flat.length) fail(`Truncated posting header for ${term}`, field);
    const doc = flat[cursor++];
    const count = flat[cursor++];
    if (doc <= previousDoc || doc >= docs.length) fail(`Invalid document offset in postings for ${term}`, field);
    if (count < 1 || cursor + count > flat.length) fail(`Invalid position count in postings for ${term}`, field);
    let previousPosition = -1;
    for (let i = 0; i < count; i++) {
      const position = flat[cursor++];
      if (position <= previousPosition || position >= docs[doc].length) {
        fail(`Invalid token position in postings for ${term}`, field);
      }
      if (docs[doc][position] !== undefined) fail(`Overlapping token positions in postings for ${term}`, field);
      docs[doc][position] = term;
      previousPosition = position;
    }
    previousDoc = doc;
    rows += 1;
  }
  return rows;
}

function completeTokens(values: Array<string | undefined>, field: string): string[] {
  if (values.some((value) => value === undefined)) fail(`Posting positions do not cover ${field}`, field);
  return values as string[];
}

function tokenPositions(tokens: string[]) {
  const out = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const term = tokens[i];
    const current = out.get(term);
    if (current) current.push(i);
    else out.set(term, [i]);
  }
  return out;
}

function runtimeFromPayload(payload: LexicalIndexPayload): CompiledLexicalRuntime {
  function rows(flat: number[]) {
    let count = 0;
    let cursor = 0;
    while (cursor < flat.length) {
      count += 1;
      cursor += 2 + flat[cursor + 1];
    }
    return count;
  }
  const terms: CompiledTermRuntime[] = payload.terms.map((row) => ({
    term: row[0],
    lemma: row[1],
    title: row[2],
    body: row[3],
    titleDf: rows(row[2]),
    bodyDf: rows(row[3]),
  }));
  const bySurface = new Map<string, CompiledTermRuntime>();
  const byLemma = new Map<string, CompiledTermRuntime[]>();
  let postingEntries = 0;
  for (const term of terms) {
    bySurface.set(term.term, term);
    const canonical = byLemma.get(term.lemma);
    if (canonical) canonical.push(term);
    else byLemma.set(term.lemma, [term]);
    for (const flat of [term.title, term.body]) {
      let cursor = 0;
      while (cursor < flat.length) {
        const count = flat[cursor + 1];
        postingEntries += 1;
        cursor += 2 + count;
      }
    }
  }
  const sortedTitles: Array<{ norm: string; pos: number }> = [];
  const titleByNorm = new Map<string, number[]>();
  const versionIndex = new Map<string, number[]>();
  const titleDl = new Array<number>(payload.documents.length);
  const bodyDl = new Array<number>(payload.documents.length);
  for (let pos = 0; pos < payload.documents.length; pos++) {
    const row = payload.documents[pos];
    titleDl[pos] = row[2];
    bodyDl[pos] = row[3];
    sortedTitles.push({ norm: row[5], pos });
    const exact = titleByNorm.get(row[5]);
    if (exact) exact.push(pos);
    else titleByNorm.set(row[5], [pos]);
    for (const form of [...row[6], ...row[7]]) {
      const list = versionIndex.get(form);
      if (list) list.push(pos);
      else versionIndex.set(form, [pos]);
    }
  }
  sortedTitles.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : a.pos - b.pos));
  return {
    terms,
    bySurface,
    byLemma,
    sortedTerms: terms.map((term) => term.term),
    sortedTitles,
    titleByNorm,
    versionIndex,
    titleDl,
    bodyDl,
    avgTitleDl: payload.stats[0] || 1,
    avgBodyDl: payload.stats[1] || 1,
    postingEntries,
  };
}

function indexFromPayload(
  payload: LexicalIndexPayload,
  artifact: LexicalIndexArtifact,
  frequencyById: Map<string, Record<string, number> | null>
): SearchIndex {
  const titleSlots = payload.documents.map((row) => new Array<string | undefined>(row[2]));
  const bodySlots = payload.documents.map((row) => new Array<string | undefined>(row[3]));
  const lemmaBySurface = new Map<string, string>();
  for (let i = 0; i < payload.terms.length; i++) {
    const [term, lemma, title, body] = payload.terms[i];
    lemmaBySurface.set(term, lemma);
    decodeField(title, term, titleSlots, `data.terms[${i}][2]`);
    decodeField(body, term, bodySlots, `data.terms[${i}][3]`);
  }

  const documents: IndexedDocument[] = payload.documents.map((row, pos) => {
    const titleTokens = completeTokens(titleSlots[pos], `data.documents[${pos}].titleTokens`);
    const bodyTokens = completeTokens(bodySlots[pos], `data.documents[${pos}].bodyTokens`);
    const titleLemmas = titleTokens.map((term) => lemmaBySurface.get(term) || term);
    const bodyLemmas = bodyTokens.map((term) => lemmaBySurface.get(term) || term);
    if (titleTokens.join(" ") !== row[5]) fail(`Normalized title mismatch for document ${row[0]}`, `data.documents[${pos}][5]`);
    if (firstSurfaceToken(row[1]) !== row[4]) fail(`First-token mismatch for document ${row[0]}`, `data.documents[${pos}][4]`);
    const dotted = new Set(row[8]);
    for (const index of dotted) {
      if (index >= titleTokens.length) fail(`Dotted component offset out of range for document ${row[0]}`, `data.documents[${pos}][8]`);
    }
    const independentTitleTokens = titleTokens.filter((_term, index) => !dotted.has(index));
    const independentTitleLemmas = titleLemmas.filter((_term, index) => !dotted.has(index));
    return {
      id: row[0],
      raw: { id: row[0], title: row[1], body: "" },
      title: row[1],
      body: "",
      titleTokens,
      bodyTokens,
      titleLemmas,
      bodyLemmas,
      titleLemmaSet: new Set(titleLemmas),
      bodyLemmaSet: new Set(bodyLemmas),
      titleTokenSet: new Set(titleTokens),
      bodyTokenSet: new Set(bodyTokens),
      nonStopTitle: titleTokens.filter((term) => !DEFAULT_STOP.has(term)),
      firstToken: row[4],
      normalizedTitle: row[5],
      versionCompactForms: row[6],
      dottedSpans: row[7],
      dottedSpanComponentIndexes: dotted,
      independentTitleTokens,
      independentTitleTokenSet: new Set(independentTitleTokens),
      independentTitleLemmaSet: new Set(independentTitleLemmas),
      bodyTokenPositions: tokenPositions(bodyTokens),
      bodyLemmaPositions: tokenPositions(bodyLemmas),
      lexicalFrequency: frequencyById.get(row[0]) || null,
    };
  });
  const titleTokenSet = new Set<string>();
  const surfaceVocabulary = new Set<string>();
  for (const doc of documents) {
    for (const term of doc.titleTokens) {
      titleTokenSet.add(term);
      surfaceVocabulary.add(term);
    }
    for (const lemma of doc.titleLemmas) titleTokenSet.add(lemma);
    for (const term of doc.bodyTokens) surfaceVocabulary.add(term);
  }
  const runtime = runtimeFromPayload(payload);
  return {
    schema: {
      fields: {
        [artifact.compatibility.schema[0]]: { type: "text", role: "title" },
        [artifact.compatibility.schema[1]]: { type: "text", role: "body" },
      },
      titleField: artifact.compatibility.schema[0],
      bodyField: artifact.compatibility.schema[1],
    },
    documents,
    byId: new Map(documents.map((doc) => [doc.id, doc])),
    titleTokenSet,
    surfaceVocabulary,
    compiledLexical: runtime,
    lexicalArtifact: artifact,
  };
}

export function parseLexicalIndex(artifactValue: unknown): {
  artifact: LexicalIndexArtifact;
  payload: LexicalIndexPayload;
} {
  const checked = assertArtifact(artifactValue, LEXICAL_INDEX_FORMAT);
  if (!plainRecord(checked.compatibility)) fail("Lexical index compatibility header is required", "compatibility");
  const core = checked.compatibility.core;
  const analyzer = checked.compatibility.analyzer;
  const schema = checked.compatibility.schema;
  if (typeof core !== "string" || typeof analyzer !== "string") {
    fail("Lexical index compatibility core/analyzer values must be strings", "compatibility");
  }
  if (!Array.isArray(schema) || schema.length !== 2 || schema.some((field) => typeof field !== "string" || !field)) {
    fail("Lexical index compatibility schema must be [titleField, bodyField]", "compatibility.schema");
  }
  if (!plainRecord(checked.corpus)) fail("Lexical index corpus header is required", "corpus");
  const documentCount = checked.corpus.documentCount;
  const fingerprint = checked.corpus.fingerprint;
  if (!finitePositiveInteger(documentCount) || typeof fingerprint !== "string" || !fingerprint) {
    fail("Lexical index corpus header is invalid", "corpus");
  }
  if (typeof checked.integrity !== "string" || !checked.integrity) fail("Lexical index integrity fingerprint is required", "integrity");
  const artifact: LexicalIndexArtifact = {
    format: LEXICAL_INDEX_FORMAT,
    version: LEXICAL_INDEX_VERSION,
    compatibility: {
      core,
      analyzer,
      schema: [schema[0] as string, schema[1] as string],
    },
    corpus: { documentCount: Number(documentCount), fingerprint },
    integrity: checked.integrity,
    data: checked.data,
  };
  const expectedIntegrity = stableFingerprint({
    compatibility: artifact.compatibility,
    corpus: artifact.corpus,
    data: artifact.data,
  });
  if (artifact.integrity !== expectedIntegrity) fail("Lexical index integrity fingerprint mismatch", "integrity");
  const payload = parsePayload(artifact.data);
  if (payload.documents.length !== artifact.corpus.documentCount) {
    fail("Lexical index document count does not match its payload", "corpus.documentCount");
  }
  return { artifact, payload };
}

export function loadLexicalIndex(
  artifactValue: unknown,
  documents: unknown,
  schema: Schema | null | undefined,
  plugins: SearchPlugin[] = []
): SearchIndex {
  const { artifact, payload } = parseLexicalIndex(artifactValue);
  const resolved = resolveSchema(schema);
  if (artifact.compatibility.core !== CORE_ANALYZER_COMPATIBILITY) {
    fail(
      `Incompatible lexical index core analyzer ${JSON.stringify(artifact.compatibility.core)}`,
      "compatibility.core"
    );
  }
  if (
    artifact.compatibility.schema[0] !== resolved.titleField ||
    artifact.compatibility.schema[1] !== resolved.bodyField
  ) {
    fail("Lexical index schema does not match SearchEngine schema", "compatibility.schema");
  }
  const analyzer = lexicalAnalyzerIdentity(plugins, { requireIdentified: true });
  if (artifact.compatibility.analyzer !== analyzer) {
    fail("Lexical index lemma/analyzer identity does not match SearchEngine plugins", "compatibility.analyzer");
  }
  const rows = sourceRows(documents, schema);
  if (rows.length !== artifact.corpus.documentCount) {
    fail("Lexical index document count does not match supplied documents", "corpus.documentCount");
  }
  if (stableFingerprint(rows) !== artifact.corpus.fingerprint) {
    fail("Lexical index corpus fingerprint does not match supplied searchable text", "corpus.fingerprint");
  }
  return indexFromPayload(
    payload,
    artifact,
    new Map(rows.map((row) => [row[0], row[3]]))
  );
}

export function ensureCompiledLexicalIndex(index: SearchIndex, plugins: SearchPlugin[] = []) {
  const existing = index.compiledLexical as CompiledLexicalRuntime | undefined;
  if (existing) return existing;
  return compileLexicalIndexFromSearchIndex(index, {
    analyzer: lexicalAnalyzerIdentity(plugins),
  }).runtime;
}
