/**
 * search-v2-lexical-index v1
 *
 * The serialized payload stores one positional posting row per normalized
 * surface term. Each surface term carries its deterministic lemma, so lemma
 * postings are reconstructed as an inverse term mapping rather than duplicated
 * in the artifact. Raw title/body text is deliberately absent; caller-supplied
 * documents provide display titles, optional summary text, and the separately
 * owned lexical-frequency data after the corpus fingerprint has been validated.
 * The v1 corpus fingerprint is (id, title, body, lexicalFrequency). Summary is
 * not stored in the artifact; load hydrates it from caller documents. Re-index
 * reuse after a consumed artifact also checks a separate hydration fingerprint
 * so a summary-only edit cannot keep stale search-relevant state.
 */

import { tokenize } from "./text.js";
import { assertArtifact } from "./artifacts.js";
import { canonicalDocumentId } from "./documentId.js";
import { ArtifactValidationError } from "./errors.js";
import { buildIndex, resolveSchema } from "./indexDocuments.js";
import { stableFingerprint } from "./stableHash.js";
import {
  compactDocuments,
  internTerm,
  type CompactDocumentStore,
} from "./compactDocuments.js";
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
export const EXACT_PRUNING_EXTENSION = "exact-pruning-v1";
export const EXACT_PRUNING_REVISION = 1 as const;
export const EXACT_PRUNING_BLOCK_SIZE = 128;
export const SUPPORTED_PRUNING_BLOCK_SIZES = new Set([32, 64, 128, 256]);
export const EXACT_PRUNING_V2_EXTENSION = "exact-pruning-v2";
export const EXACT_PRUNING_V2_REVISION = 1 as const;
export const EXACT_PRUNING_V2_MASK_WORDS = 4;

// Document tuple:
// [id, titleTokenLength, bodyTokenLength, firstSurfaceToken,
//  versionCompactForms, dottedSpans, dottedSpanComponentIndexes]
type SerializedDocument = [
  string,
  number,
  number,
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
  /**
   * Additive capability namespace. The exact-pruning-v1 extension references
   * stable document ordinals without changing the core v1 positional data.
   */
  extensions: Record<string, unknown>;
};

type SourceRow = [string, string, string, Record<string, number> | null, string, string[]];

export type ExactPruningExtensionV1 = {
  revision: typeof EXACT_PRUNING_REVISION;
  unit: "document-ordinal";
  blockSize: number;
  boundaries: number[];
};

export type ExactPruningExtensionV2 = {
  revision: typeof EXACT_PRUNING_V2_REVISION;
  unit: "document-ordinal";
  blockSize: number;
  documentCount: number;
  maskWords: typeof EXACT_PRUNING_V2_MASK_WORDS;
  terms: Array<[string, number[][]]>;
};

export type TermBodyPresence = {
  blockIndexes: Uint32Array;
  words: Uint32Array;
};

export type CompiledTermRuntime = {
  term: string;
  lemma: string;
  title: number[];
  body: number[];
  titleDf: number;
  bodyDf: number;
  bodyPresence: TermBodyPresence | null;
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
  exactPruning: ExactPruningExtensionV1 | null;
  exactPruningV2: ExactPruningExtensionV2 | null;
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

/**
 * Runtime hydration identity. Includes optional summary when the schema has
 * role `summary`. Not stored on the v1 artifact; used only to refuse re-index
 * reuse of a consumed lexical index whose caller summaries changed.
 */
function hydrationRows(documents: unknown, schema?: Schema | null) {
  const { titleField, bodyField, summaryField } = resolveSchema(schema);
  if (!summaryField) return sourceRows(documents, schema);
  const byId = new Map<string, [string, string, string, Record<string, number> | null, string]>();
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
    const summary = String(doc[summaryField] ?? doc.summary ?? "");
    byId.set(id, [id, title, body, sortedNumberRecord(doc.lexicalFrequency), summary]);
  }
  return [...byId.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function compactSourceById(documents: unknown, schema?: Schema | null): Map<string, SourceRow> {
  const { titleField, bodyField, summaryField } = resolveSchema(schema);
  const byId = new Map<string, SourceRow>();
  const rows = inputDocuments(documents);
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i];
    if (!plainRecord(value)) continue;
    const doc = value as SearchDocument;
    const id = canonicalDocumentId(doc.id);
    if (!id) continue;
    const title = doc[titleField] == null && doc.title == null ? "" : String(doc[titleField] ?? doc.title ?? "");
    const body = doc[bodyField] == null && doc.body == null ? "" : String(doc[bodyField] ?? doc.body ?? "");
    const summary = summaryField ? String(doc[summaryField] ?? doc.summary ?? "") : "";
    byId.set(id, [id, title, body, sortedNumberRecord(doc.lexicalFrequency), summary, tokenize(summary)]);
  }
  return byId;
}

export function lexicalCorpusFingerprint(documents: unknown, schema?: Schema | null) {
  return stableFingerprint(sourceRows(documents, schema));
}

export function lexicalHydrationFingerprint(documents: unknown, schema?: Schema | null) {
  return stableFingerprint(hydrationRows(documents, schema));
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
    doc.titleTokens.length,
    doc.bodyTokens.length,
    doc.firstToken,
    [...doc.versionCompactForms],
    [...doc.dottedSpans],
    [...doc.dottedSpanComponentIndexes].sort((a, b) => a - b),
  ]);
}

export function documentBlockBoundaries(documentCount: number, blockSize = EXACT_PRUNING_BLOCK_SIZE): number[] {
  if (!finitePositiveInteger(documentCount)) throw new TypeError("documentCount must be a non-negative integer");
  if (!SUPPORTED_PRUNING_BLOCK_SIZES.has(blockSize)) {
    throw new TypeError(`blockSize must be one of ${[...SUPPORTED_PRUNING_BLOCK_SIZES].join(", ")}`);
  }
  const out = [0];
  for (let start = blockSize; start < documentCount; start += blockSize) out.push(start);
  if (documentCount > 0) out.push(documentCount);
  return out;
}

function buildExactPruningExtension(documentCount: number): ExactPruningExtensionV1 {
  return {
    revision: EXACT_PRUNING_REVISION,
    unit: "document-ordinal",
    blockSize: EXACT_PRUNING_BLOCK_SIZE,
    boundaries: documentBlockBoundaries(documentCount),
  };
}

function buildExactPruningV2Extension(terms: SerializedTerm[], documentCount: number): ExactPruningExtensionV2 {
  const blockSize = EXACT_PRUNING_BLOCK_SIZE;
  const encoded: Array<[string, number[][]]> = [];
  for (const row of terms) {
    const body = row[3];
    if (!body.length) continue;
    let minDoc = Infinity;
    let maxDoc = -1;
    const blocks = new Map<number, [number, number, number, number]>();
    let cursor = 0;
    while (cursor < body.length) {
      const doc = body[cursor++];
      const tf = body[cursor++];
      cursor += tf;
      if (doc < minDoc) minDoc = doc;
      if (doc > maxDoc) maxDoc = doc;
      const block = Math.floor(doc / blockSize);
      let words = blocks.get(block);
      if (!words) {
        words = [0, 0, 0, 0];
        blocks.set(block, words);
      }
      const bit = doc - block * blockSize;
      const word = (bit / 32) | 0;
      words[word] = (words[word] | (1 << (bit % 32))) >>> 0;
    }
    if (minDoc === Infinity) continue;
    if (Math.floor(minDoc / blockSize) === Math.floor(maxDoc / blockSize)) continue;
    const blockRows = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, words]) => [index, words[0], words[1], words[2], words[3]]);
    encoded.push([row[0], blockRows]);
  }
  return {
    revision: EXACT_PRUNING_V2_REVISION,
    unit: "document-ordinal",
    blockSize,
    documentCount,
    maskWords: EXACT_PRUNING_V2_MASK_WORDS,
    terms: encoded,
  };
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
    extensions: {
      [EXACT_PRUNING_EXTENSION]: buildExactPruningExtension(n),
      [EXACT_PRUNING_V2_EXTENSION]: buildExactPruningV2Extension(sortedTerms, n),
    },
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

function sourceRowsFromIndex(index: SearchIndex): Map<string, SourceRow> {
  return new Map(
    index.documents.map((doc) => [
      doc.id,
      [
        doc.id,
        doc.title,
        "",
        doc.lexicalFrequency,
        doc.summary || "",
        Array.isArray(doc.summaryTokens) ? [...doc.summaryTokens] : [],
      ],
    ])
  );
}

export function compactIndexFromAnalyzed(
  index: SearchIndex,
  analyzer = IDENTITY_LEMMA_COMPATIBILITY
): SearchIndex {
  const payload = buildPayload(index);
  const artifact = envelope(payload, index, analyzer);
  const next = indexFromPayload(payload, artifact, sourceRowsFromIndex(index), index.schema.fields);
  const positional = (index as SearchIndex & { positional?: unknown }).positional;
  if (positional && index.documents.length === next.documents.length) {
    (next as SearchIndex & { positional?: unknown }).positional = positional;
  }
  return next;
}

export function compileLexicalIndexFromSearchIndex(
  index: SearchIndex,
  { analyzer = IDENTITY_LEMMA_COMPATIBILITY }: { analyzer?: string } = {}
) {
  const payload = buildPayload(index);
  const artifact = envelope(payload, index, analyzer);
  const store = compactStoreFromPayload(payload, artifact, sourceRowsFromIndex(index));
  const runtime = runtimeFromPayload(payload, store);
  index.compiledLexical = runtime;
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
  if (!Array.isArray(value) || value.length !== 7) fail(`${field} must be a 7-value document tuple`, field);
  const [id, titleLength, bodyLength, first, versions, spans, marked] = value;
  if (typeof id !== "string" || !id) fail(`${field}[0] must be a non-empty id`, `${field}[0]`);
  if (!finitePositiveInteger(titleLength)) fail(`${field}[1] must be a token length`, `${field}[1]`);
  if (!finitePositiveInteger(bodyLength)) fail(`${field}[2] must be a token length`, `${field}[2]`);
  if (typeof first !== "string") fail(`${field}[3] must be a first-token string`, `${field}[3]`);
  return [
    id,
    titleLength,
    bodyLength,
    first,
    requireStringArray(versions, `${field}[4]`),
    requireStringArray(spans, `${field}[5]`),
    requireNumberArray(marked, `${field}[6]`),
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

function parseExactPruningExtension(
  value: unknown,
  documentCount: number
): ExactPruningExtensionV1 | null {
  if (value === undefined) return null;
  const field = `data.extensions.${EXACT_PRUNING_EXTENSION}`;
  if (!plainRecord(value)) fail(`${field} must be a plain object`, field);
  if (value.revision !== EXACT_PRUNING_REVISION) {
    fail(`${field}.revision is unsupported`, `${field}.revision`);
  }
  if (value.unit !== "document-ordinal") {
    fail(`${field}.unit must be document-ordinal`, `${field}.unit`);
  }
  if (
    typeof value.blockSize !== "number" ||
    !Number.isInteger(value.blockSize) ||
    !SUPPORTED_PRUNING_BLOCK_SIZES.has(value.blockSize)
  ) {
    fail(`${field}.blockSize is unsupported`, `${field}.blockSize`);
  }
  if (!Array.isArray(value.boundaries) || value.boundaries.some((n) => !finitePositiveInteger(n))) {
    fail(`${field}.boundaries must be non-negative integer offsets`, `${field}.boundaries`);
  }
  const blockSize = value.blockSize;
  const boundaries = value.boundaries.map(Number);
  const expected = documentBlockBoundaries(documentCount, blockSize);
  if (
    boundaries.length !== expected.length ||
    boundaries.some((boundary, index) => boundary !== expected[index])
  ) {
    fail(`${field}.boundaries must cover sorted document ordinals exactly`, `${field}.boundaries`);
  }
  return {
    revision: EXACT_PRUNING_REVISION,
    unit: "document-ordinal",
    blockSize,
    boundaries,
  };
}

function unsigned32(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`${field} must be an unsigned 32-bit integer`, field);
  }
  return value >>> 0;
}

function parseExactPruningV2Extension(
  value: unknown,
  documentCount: number,
  termNames: string[],
  blockSize: number
): ExactPruningExtensionV2 | null {
  if (value === undefined) return null;
  const field = `data.extensions.${EXACT_PRUNING_V2_EXTENSION}`;
  if (!plainRecord(value)) fail(`${field} must be a plain object`, field);
  if (value.revision !== EXACT_PRUNING_V2_REVISION) {
    fail(`${field}.revision is unsupported`, `${field}.revision`);
  }
  if (value.unit !== "document-ordinal") {
    fail(`${field}.unit must be document-ordinal`, `${field}.unit`);
  }
  if (value.blockSize !== blockSize) {
    fail(`${field}.blockSize must match exact-pruning-v1`, `${field}.blockSize`);
  }
  if (value.documentCount !== documentCount) {
    fail(`${field}.documentCount must match the compiled corpus`, `${field}.documentCount`);
  }
  if (value.maskWords !== EXACT_PRUNING_V2_MASK_WORDS) {
    fail(`${field}.maskWords must be ${EXACT_PRUNING_V2_MASK_WORDS}`, `${field}.maskWords`);
  }
  if (!Array.isArray(value.terms)) fail(`${field}.terms must be an array`, `${field}.terms`);
  const knownTerms = new Set(termNames);
  const nBlocks = Math.max(1, Math.ceil(documentCount / blockSize));
  const lastBlockWidth = documentCount === 0 ? 0 : ((documentCount - 1) % blockSize) + 1;
  const parsed: Array<[string, number[][]]> = [];
  let previousTerm = "";
  for (let i = 0; i < value.terms.length; i++) {
    const row = value.terms[i];
    const rowField = `${field}.terms[${i}]`;
    if (!Array.isArray(row) || row.length !== 2) fail(`${rowField} must be [term, blocks]`, rowField);
    const term = row[0];
    const blocks = row[1];
    if (typeof term !== "string" || !term) fail(`${rowField}[0] must be a non-empty term`, `${rowField}[0]`);
    if (term <= previousTerm) fail(`${rowField}[0] must be sorted and unique`, `${rowField}[0]`);
    if (!knownTerms.has(term)) fail(`${rowField}[0] is not a compiled term`, `${rowField}[0]`);
    previousTerm = term;
    if (!Array.isArray(blocks)) fail(`${rowField}[1] must be an array`, `${rowField}[1]`);
    const encoded: number[][] = [];
    let previousBlock = -1;
    for (let b = 0; b < blocks.length; b++) {
      const blockRow = blocks[b];
      const blockField = `${rowField}[1][${b}]`;
      if (!Array.isArray(blockRow) || blockRow.length !== 5) {
        fail(`${blockField} must be [blockIndex, w0, w1, w2, w3]`, blockField);
      }
      const blockIndex = unsigned32(blockRow[0], `${blockField}[0]`);
      if (blockIndex <= previousBlock) fail(`${blockField}[0] must be sorted and unique`, `${blockField}[0]`);
      if (blockIndex >= nBlocks) fail(`${blockField}[0] is out of range`, `${blockField}[0]`);
      previousBlock = blockIndex;
      const words = [
        unsigned32(blockRow[1], `${blockField}[1]`),
        unsigned32(blockRow[2], `${blockField}[2]`),
        unsigned32(blockRow[3], `${blockField}[3]`),
        unsigned32(blockRow[4], `${blockField}[4]`),
      ];
      if (words.every((word) => word === 0)) fail(`${blockField} must be a non-empty mask`, blockField);
      if (blockIndex === nBlocks - 1 && lastBlockWidth < EXACT_PRUNING_BLOCK_SIZE) {
        for (let bit = lastBlockWidth; bit < EXACT_PRUNING_BLOCK_SIZE; bit++) {
          const word = (bit / 32) | 0;
          if (words[word] & (1 << (bit % 32))) {
            fail(`${blockField} has bits past the final document ordinal`, blockField);
          }
        }
      }
      encoded.push([blockIndex, ...words]);
    }
    parsed.push([term, encoded]);
  }
  return {
    revision: EXACT_PRUNING_V2_REVISION,
    unit: "document-ordinal",
    blockSize,
    documentCount,
    maskWords: EXACT_PRUNING_V2_MASK_WORDS,
    terms: parsed,
  };
}

function parsePayload(value: unknown): LexicalIndexPayload {
  if (!plainRecord(value)) fail("Lexical index data must be a plain object", "data");
  if (!Array.isArray(value.documents)) fail("Lexical index data.documents must be an array", "data.documents");
  if (!Array.isArray(value.terms)) fail("Lexical index data.terms must be an array", "data.terms");
  if (!Array.isArray(value.stats) || value.stats.length !== 2 || value.stats.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
    fail("Lexical index data.stats must be [avgTitleLength, avgBodyLength]", "data.stats");
  }
  if (!plainRecord(value.extensions)) {
    fail("Lexical index data.extensions must be a plain object", "data.extensions");
  }
  const documents = value.documents.map(parseDocument);
  const terms = value.terms.map(parseTerm);
  for (let i = 1; i < documents.length; i++) {
    if (documents[i - 1][0] >= documents[i][0]) fail("Lexical index documents must have unique, sorted ids", "data.documents");
  }
  for (let i = 1; i < terms.length; i++) {
    if (terms[i - 1][0] >= terms[i][0]) fail("Lexical index terms must be unique and sorted", "data.terms");
  }
  const extensions = { ...value.extensions };
  const exactPruning = parseExactPruningExtension(extensions[EXACT_PRUNING_EXTENSION], documents.length);
  if (exactPruning) extensions[EXACT_PRUNING_EXTENSION] = exactPruning;
  const exactPruningV2 = parseExactPruningV2Extension(
    extensions[EXACT_PRUNING_V2_EXTENSION],
    documents.length,
    terms.map((row) => row[0]),
    exactPruning?.blockSize || EXACT_PRUNING_BLOCK_SIZE
  );
  if (exactPruningV2) extensions[EXACT_PRUNING_V2_EXTENSION] = exactPruningV2;
  return {
    documents,
    terms,
    stats: [Number(value.stats[0]), Number(value.stats[1])],
    extensions,
  };
}

function runtimeFromPayload(
  payload: LexicalIndexPayload,
  store: CompactDocumentStore
): CompiledLexicalRuntime {
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
    bodyPresence: null,
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
  const n = store.n;
  const sortedTitles: Array<{ norm: string; pos: number }> = [];
  const titleByNorm = new Map<string, number[]>();
  const versionIndex = new Map<string, number[]>();
  const titleDl = new Array<number>(n);
  const bodyDl = new Array<number>(n);
  for (let pos = 0; pos < n; pos++) {
    titleDl[pos] = store.titleOff[pos + 1] - store.titleOff[pos];
    bodyDl[pos] = store.bodyOff[pos + 1] - store.bodyOff[pos];
    const norm = store.normalizedTitles[pos];
    sortedTitles.push({ norm, pos });
    const exact = titleByNorm.get(norm);
    if (exact) exact.push(pos);
    else titleByNorm.set(norm, [pos]);
    for (const form of [...store.versionForms[pos], ...store.dottedSpans[pos]]) {
      const list = versionIndex.get(form);
      if (list) list.push(pos);
      else versionIndex.set(form, [pos]);
    }
  }
  sortedTitles.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : a.pos - b.pos));
  const exactPruning = (payload.extensions[EXACT_PRUNING_EXTENSION] as ExactPruningExtensionV1 | undefined) || null;
  const exactPruningV2 = (payload.extensions[EXACT_PRUNING_V2_EXTENSION] as ExactPruningExtensionV2 | undefined) || null;
  if (exactPruningV2) {
    const byTerm = new Map(terms.map((term) => [term.term, term]));
    for (const [name, blocks] of exactPruningV2.terms) {
      const term = byTerm.get(name);
      if (!term) continue;
      const blockIndexes = new Uint32Array(blocks.length);
      const words = new Uint32Array(blocks.length * EXACT_PRUNING_V2_MASK_WORDS);
      for (let i = 0; i < blocks.length; i++) {
        const row = blocks[i];
        blockIndexes[i] = row[0];
        words[i * EXACT_PRUNING_V2_MASK_WORDS] = row[1];
        words[i * EXACT_PRUNING_V2_MASK_WORDS + 1] = row[2];
        words[i * EXACT_PRUNING_V2_MASK_WORDS + 2] = row[3];
        words[i * EXACT_PRUNING_V2_MASK_WORDS + 3] = row[4];
      }
      term.bodyPresence = { blockIndexes, words };
    }
  }
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
    exactPruning,
    exactPruningV2,
  };
}

function decodeFieldIds(
  flat: number[],
  termId: number,
  ids: Uint32Array,
  off: Uint32Array,
  term: string,
  field: string
) {
  let cursor = 0;
  let previousDoc = -1;
  const documentCount = off.length - 1;
  while (cursor < flat.length) {
    if (cursor + 2 > flat.length) fail(`Truncated posting header for ${term}`, field);
    const doc = flat[cursor++];
    const count = flat[cursor++];
    if (doc <= previousDoc || doc >= documentCount) fail(`Invalid document offset in postings for ${term}`, field);
    if (count < 1 || cursor + count > flat.length) fail(`Invalid position count in postings for ${term}`, field);
    const start = off[doc];
    const len = off[doc + 1] - start;
    let previousPosition = -1;
    for (let i = 0; i < count; i++) {
      const position = flat[cursor++];
      if (position <= previousPosition || position >= len) {
        fail(`Invalid token position in postings for ${term}`, field);
      }
      const slot = start + position;
      if (ids[slot] !== 0) fail(`Overlapping token positions in postings for ${term}`, field);
      ids[slot] = termId;
      previousPosition = position;
    }
    previousDoc = doc;
  }
}

function compactStoreFromPayload(
  payload: LexicalIndexPayload,
  artifact: LexicalIndexArtifact,
  sourceById: Map<string, SourceRow>
): CompactDocumentStore {
  const n = payload.documents.length;
  const strings = [""];
  const idOf = new Map<string, number>([["", 0]]);
  for (const [term, lemma] of payload.terms) {
    internTerm(strings, idOf, term);
    internTerm(strings, idOf, lemma);
  }
  const lemmaOf = new Uint32Array(strings.length);
  for (const [term, lemma] of payload.terms) {
    lemmaOf[idOf.get(term) as number] = idOf.get(lemma) as number;
  }
  for (let i = 1; i < strings.length; i++) {
    if (lemmaOf[i] === 0) lemmaOf[i] = i;
  }

  const titleOff = new Uint32Array(n + 1);
  const bodyOff = new Uint32Array(n + 1);
  const dottedOff = new Uint32Array(n + 1);
  let titleLen = 0;
  let bodyLen = 0;
  let dottedLen = 0;
  for (let i = 0; i < n; i++) {
    titleOff[i] = titleLen;
    bodyOff[i] = bodyLen;
    dottedOff[i] = dottedLen;
    titleLen += payload.documents[i][1];
    bodyLen += payload.documents[i][2];
    dottedLen += payload.documents[i][6].length;
  }
  titleOff[n] = titleLen;
  bodyOff[n] = bodyLen;
  dottedOff[n] = dottedLen;
  const titleIds = new Uint32Array(titleLen);
  const bodyIds = new Uint32Array(bodyLen);
  const dottedIdx = new Uint32Array(dottedLen);

  const titleTokenSet = new Set<string>();
  const surfaceVocabulary = new Set<string>();
  for (let i = 0; i < payload.terms.length; i++) {
    const [term, lemma, title, body] = payload.terms[i];
    const termId = idOf.get(term) as number;
    surfaceVocabulary.add(term);
    decodeFieldIds(title, termId, titleIds, titleOff, term, `data.terms[${i}][2]`);
    decodeFieldIds(body, termId, bodyIds, bodyOff, term, `data.terms[${i}][3]`);
  }
  for (let i = 0; i < titleLen; i++) {
    if (titleIds[i] === 0) fail("Posting positions do not cover data.documents.titleTokens", "data.documents");
    titleTokenSet.add(strings[titleIds[i]]);
    titleTokenSet.add(strings[lemmaOf[titleIds[i]]]);
  }
  for (let i = 0; i < bodyLen; i++) {
    if (bodyIds[i] === 0) fail("Posting positions do not cover data.documents.bodyTokens", "data.documents");
  }

  const ids = new Array<string>(n);
  const titles = new Array<string>(n);
  const normalizedTitles = new Array<string>(n);
  const firstToken = new Array<string>(n);
  const versionForms = new Array<string[]>(n);
  const dottedSpans = new Array<string[]>(n);
  const lexicalFrequency = new Array<Record<string, number> | null>(n);
  const summaries = new Array<string>(n);
  const summaryTokenRows = new Array<string[]>(n);
  for (let pos = 0; pos < n; pos++) {
    const row = payload.documents[pos];
    const source = sourceById.get(row[0]);
    if (!source) fail(`Missing validated source document ${row[0]}`, `data.documents[${pos}][0]`);
    ids[pos] = row[0];
    titles[pos] = source[1];
    firstToken[pos] = row[3];
    versionForms[pos] = row[4].length ? row[4] : [];
    dottedSpans[pos] = row[5].length ? row[5] : [];
    lexicalFrequency[pos] = source[3];
    summaries[pos] = source[4] || "";
    summaryTokenRows[pos] = source[5] && source[5].length ? source[5] : [];
    const marked = row[6];
    const dottedStart = dottedOff[pos];
    for (let i = 0; i < marked.length; i++) {
      if (marked[i] >= row[1]) fail(`Dotted component offset out of range for document ${row[0]}`, `data.documents[${pos}][6]`);
      dottedIdx[dottedStart + i] = marked[i];
    }
    const start = titleOff[pos];
    const end = titleOff[pos + 1];
    let norm = "";
    for (let i = start; i < end; i++) {
      if (i > start) norm += " ";
      norm += strings[titleIds[i]];
    }
    normalizedTitles[pos] = norm;
  }

  return {
    n,
    strings,
    idOf,
    lemmaOf,
    titleIds,
    titleOff,
    bodyIds,
    bodyOff,
    ids,
    titles,
    normalizedTitles,
    firstToken,
    versionForms,
    dottedSpans,
    dottedOff,
    dottedIdx,
    lexicalFrequency,
    summaries,
    summaryTokenRows,
    titleTokenSet,
    surfaceVocabulary,
  };
}

function indexFromPayload(
  payload: LexicalIndexPayload,
  artifact: LexicalIndexArtifact,
  sourceById: Map<string, SourceRow>,
  schema?: Schema | null
): SearchIndex {
  const store = compactStoreFromPayload(payload, artifact, sourceById);
  const documents = compactDocuments(store);
  const resolved = resolveSchema(schema);
  const fields: Schema = {
    [artifact.compatibility.schema[0]]: { type: "text", role: "title" },
    [artifact.compatibility.schema[1]]: { type: "text", role: "body" },
  };
  if (resolved.summaryField) {
    fields[resolved.summaryField] = { type: "text", role: "summary" };
  }
  return {
    schema: {
      fields,
      titleField: artifact.compatibility.schema[0],
      bodyField: artifact.compatibility.schema[1],
      summaryField: resolved.summaryField,
    },
    documents,
    byId: new Map(documents.map((doc) => [doc.id, doc])),
    titleTokenSet: store.titleTokenSet,
    surfaceVocabulary: store.surfaceVocabulary,
    compiledLexical: runtimeFromPayload(payload, store),
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
  return indexFromPayload(payload, artifact, compactSourceById(documents, schema), schema);
}

export function ensureCompiledLexicalIndex(index: SearchIndex, plugins: SearchPlugin[] = []) {
  const existing = index.compiledLexical as CompiledLexicalRuntime | undefined;
  if (existing) return existing;
  return compileLexicalIndexFromSearchIndex(index, {
    analyzer: lexicalAnalyzerIdentity(plugins),
  }).runtime;
}

export function exactPruningRuntime(index: SearchIndex): {
  extension: ExactPruningExtensionV1;
} | null {
  const runtime = index.compiledLexical as CompiledLexicalRuntime | undefined;
  if (!runtime?.exactPruning) return null;
  return {
    extension: runtime.exactPruning,
  };
}
