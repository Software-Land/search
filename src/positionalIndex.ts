/**
 * Per-field inverted positional postings.
 *
 * Contract: for each of title / summary / body, a term maps to document array
 * indexes and monotonically increasing token positions in that field's
 * tokenizer stream. Built at index time. Query execution uses these postings
 * as the primary candidate source for PhraseQuery, PhrasePrefixQuery, and
 * configured-form token-graph matching.
 */

import type { IndexedDocument, SearchIndex } from "./types.js";

export type PhraseField = "title" | "summary" | "body";

export const PHRASE_FIELDS: PhraseField[] = ["title", "summary", "body"];

export interface TermPostings {
  byDoc: Map<number, number[]>;
}

export interface FieldInverted {
  terms: Map<string, TermPostings>;
}

export interface PositionalIndex {
  fields: Record<PhraseField, FieldInverted>;
  documentCount: number;
  tokenCount: number;
}

function emptyField(): FieldInverted {
  return { terms: new Map() };
}

function addPosition(field: FieldInverted, term: string, doc: number, pos: number) {
  if (!term) return;
  let postings = field.terms.get(term);
  if (!postings) {
    postings = { byDoc: new Map() };
    field.terms.set(term, postings);
  }
  const row = postings.byDoc.get(doc);
  if (row) row.push(pos);
  else postings.byDoc.set(doc, [pos]);
}

export function tokensOf(doc: IndexedDocument, field: PhraseField): string[] {
  if (field === "title") return doc.titleTokens || [];
  if (field === "summary") return doc.summaryTokens || [];
  return doc.bodyTokens || [];
}

export function buildPositionalIndex(documents: IndexedDocument[]): PositionalIndex {
  const fields: Record<PhraseField, FieldInverted> = {
    title: emptyField(),
    summary: emptyField(),
    body: emptyField(),
  };
  let tokenCount = 0;
  for (let d = 0; d < documents.length; d++) {
    for (const field of PHRASE_FIELDS) {
      const tokens = tokensOf(documents[d], field);
      tokenCount += tokens.length;
      for (let p = 0; p < tokens.length; p++) addPosition(fields[field], tokens[p], d, p);
    }
  }
  return { fields, documentCount: documents.length, tokenCount };
}

export function positionalIndexOf(index: SearchIndex): PositionalIndex {
  const existing = (index as SearchIndex & { positional?: PositionalIndex }).positional;
  if (existing) return existing;
  const built = buildPositionalIndex(index.documents);
  (index as SearchIndex & { positional?: PositionalIndex }).positional = built;
  return built;
}
