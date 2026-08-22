/**
 * Exhaustive-judgment validator for search-relevance-corpus / search-relevance-eval v1.
 *
 * Unjudged documents are never interpreted as grade 0. Missing or extra
 * judgment IDs fail validation.
 */

export const CORPUS_FORMAT = "search-relevance-corpus";
export const EVAL_FORMAT = "search-relevance-eval";
export const FORMAT_VERSION = 1;
export const MIN_GRADE = 0;
export const MAX_GRADE = 3;

export class RelevanceValidationError extends Error {
  constructor(message, { path } = {}) {
    super(message);
    this.name = "RelevanceValidationError";
    this.path = path || "";
  }
}

function fail(message, path) {
  throw new RelevanceValidationError(message, { path });
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) fail(`expected a JSON object`, path);
}

function assertExactKeys(obj, allowed, path) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) fail(`unknown field "${key}"`, path);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(`missing field "${key}"`, path);
  }
}

function assertHasKeys(obj, required, path) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(`missing field "${key}"`, path);
  }
}

function assertString(value, path, { nonEmpty = false } = {}) {
  if (typeof value !== "string") fail(`expected a string`, path);
  if (nonEmpty && value === "") fail(`expected a non-empty string`, path);
}

function assertIntegerVersion(value, path) {
  if (value !== FORMAT_VERSION) {
    fail(`expected version ${FORMAT_VERSION}, got ${JSON.stringify(value)}`, path);
  }
}

function assertGrade(value, path) {
  if (!Number.isInteger(value) || value < MIN_GRADE || value > MAX_GRADE) {
    fail(`grade must be an integer ${MIN_GRADE}–${MAX_GRADE}, got ${JSON.stringify(value)}`, path);
  }
}

/**
 * @returns {{ id: string, documentIds: string[] }}
 */
export function validateCorpus(corpus) {
  assertPlainObject(corpus, "");
  assertExactKeys(corpus, ["format", "version", "id", "documents"], "");
  if (corpus.format !== CORPUS_FORMAT) {
    fail(`expected format ${JSON.stringify(CORPUS_FORMAT)}, got ${JSON.stringify(corpus.format)}`, "format");
  }
  assertIntegerVersion(corpus.version, "version");
  assertString(corpus.id, "id", { nonEmpty: true });
  if (!Array.isArray(corpus.documents)) fail(`expected an array`, "documents");
  if (corpus.documents.length < 1) fail(`corpus must contain at least one document`, "documents");

  const documentIds = [];
  const seen = new Set();
  for (let i = 0; i < corpus.documents.length; i++) {
    const doc = corpus.documents[i];
    const path = `documents[${i}]`;
    assertPlainObject(doc, path);
    assertHasKeys(doc, ["id", "title", "body"], path);
    assertString(doc.id, `${path}.id`, { nonEmpty: true });
    assertString(doc.title, `${path}.title`);
    assertString(doc.body, `${path}.body`);
    if (seen.has(doc.id)) fail(`duplicate document id ${JSON.stringify(doc.id)}`, `${path}.id`);
    seen.add(doc.id);
    documentIds.push(doc.id);
  }

  return { id: corpus.id, documentIds };
}

/**
 * Exhaustive: every query grades every corpus document, and nothing else.
 * @returns {{ corpus: string, queryIds: string[] }}
 */
export function validateJudgments(judgments, corpus) {
  const { id: corpusId, documentIds } = validateCorpus(corpus);
  assertPlainObject(judgments, "");
  assertExactKeys(judgments, ["format", "version", "corpus", "queries"], "");
  if (judgments.format !== EVAL_FORMAT) {
    fail(`expected format ${JSON.stringify(EVAL_FORMAT)}, got ${JSON.stringify(judgments.format)}`, "format");
  }
  assertIntegerVersion(judgments.version, "version");
  assertString(judgments.corpus, "corpus", { nonEmpty: true });
  if (judgments.corpus !== corpusId) {
    fail(
      `judgment corpus ${JSON.stringify(judgments.corpus)} does not match corpus id ${JSON.stringify(corpusId)}`,
      "corpus"
    );
  }
  if (!Array.isArray(judgments.queries)) fail(`expected an array`, "queries");
  if (judgments.queries.length < 1) fail(`judgments must contain at least one query`, "queries");

  const corpusIdSet = new Set(documentIds);
  const queryIds = [];
  const seenQueries = new Set();

  for (let i = 0; i < judgments.queries.length; i++) {
    const q = judgments.queries[i];
    const path = `queries[${i}]`;
    assertPlainObject(q, path);
    assertExactKeys(q, ["id", "query", "judgments"], path);
    assertString(q.id, `${path}.id`, { nonEmpty: true });
    if (seenQueries.has(q.id)) fail(`duplicate query id ${JSON.stringify(q.id)}`, `${path}.id`);
    seenQueries.add(q.id);
    queryIds.push(q.id);
    assertString(q.query, `${path}.query`);
    assertPlainObject(q.judgments, `${path}.judgments`);

    const judgedIds = Object.keys(q.judgments);
    for (const docId of documentIds) {
      if (!Object.prototype.hasOwnProperty.call(q.judgments, docId)) {
        fail(`missing judgment for document ${JSON.stringify(docId)}`, `${path}.judgments`);
      }
    }
    for (const docId of judgedIds) {
      if (!corpusIdSet.has(docId)) {
        fail(`judgment for unknown document ${JSON.stringify(docId)}`, `${path}.judgments.${docId}`);
      }
      assertGrade(q.judgments[docId], `${path}.judgments.${docId}`);
    }
  }

  return { corpus: corpusId, queryIds };
}
