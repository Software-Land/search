/**
 * PhraseQuery, PhrasePrefixQuery, and token-graph execution on positional postings.
 *
 * PhrasePrefix does not use allowPrefixMatch, prefixCompletion, or length ratios.
 * Final-position prefix inspects the document token immediately after the
 * contiguous exact preceding match.
 */

import { PHRASE_FIELDS, positionalIndexOf, tokensOf, type PhraseField, type PositionalIndex } from "../indexing/positionalIndex.js";
import type { IndexedDocument, SearchIndex } from "../types.js";

export interface PhraseQuery {
  kind: "phrase";
  tokens: string[];
  field?: PhraseField;
}

export interface PhrasePrefixQuery {
  kind: "phrase-prefix";
  preceding: string[];
  prefix: string;
  field?: PhraseField;
}

/** Minimal DAG walk used by executeTokenGraph. Avoids importing the graph builder. */
export interface WalkableTokenGraph {
  length: number;
  edgesFrom: Array<Array<{ to: number; tokens: string[] }>>;
}

export interface ExecutionStats {
  postingListsTouched: number;
  /** Unique documents in the candidate union for this execute* call. */
  docsVisited: number;
  /** (document, field) frequency probes, including empty-posting early exits. */
  fieldDocProbes: number;
  /**
   * Posting-list alignment (`nextAligned`) plus token-equality compares.
   * PhrasePrefix next-token `startsWith` checks are counted here and also in
   * `prefixNextTokenInspections`. Empty preceding lists return before either
   * counter moves.
   */
  positionalComparisons: number;
  /** Next-document-token prefix inspections after a contiguous preceding match. */
  prefixNextTokenInspections: number;
  /** Distinct (queryState, documentPos) cells evaluated while matching a graph. */
  graphStatesVisited: number;
  /** Suffix DP cache hits for a previously evaluated (queryState, documentPos). */
  graphDedupHits: number;
}

export interface FieldPhraseHit {
  document: IndexedDocument;
  titleFrequency: number;
  summaryFrequency: number;
  bodyFrequency: number;
}

const emptyStats = (): ExecutionStats => ({
  postingListsTouched: 0,
  docsVisited: 0,
  fieldDocProbes: 0,
  positionalComparisons: 0,
  prefixNextTokenInspections: 0,
  graphStatesVisited: 0,
  graphDedupHits: 0,
});

export function emptyExecutionStats(): ExecutionStats {
  return emptyStats();
}

function nextAligned(positions: number[], minPos: number, stats: ExecutionStats): number | null {
  stats.positionalComparisons += 1;
  const n = positions.length;
  if (!n || positions[n - 1] < minPos) return null;
  if (n <= 8) {
    for (let i = 0; i < n; i++) {
      if (positions[i] >= minPos) return positions[i];
    }
    return null;
  }
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid] < minPos) lo = mid + 1;
    else hi = mid;
  }
  return lo < n ? positions[lo] : null;
}

function phraseFrequency(
  index: PositionalIndex,
  tokens: string[],
  field: PhraseField,
  doc: number,
  stats: ExecutionStats
): number {
  if (!tokens.length) return 0;
  const inverted = index.fields[field];
  const lists = tokens.map((tok) => {
    stats.postingListsTouched += 1;
    return inverted.terms.get(tok)?.byDoc.get(doc) || null;
  });
  if (lists.some((row) => !row || !row.length)) return 0;
  const first = lists[0]!;
  let count = 0;
  for (const start of first) {
    let pos = start;
    let ok = true;
    for (let t = 1; t < lists.length; t++) {
      const want = pos + 1;
      const hit = nextAligned(lists[t]!, want, stats);
      if (hit !== want) {
        ok = false;
        break;
      }
      pos = hit;
    }
    if (ok) count += 1;
  }
  return count;
}

function phrasePrefixFrequency(
  index: PositionalIndex,
  preceding: string[],
  prefix: string,
  field: PhraseField,
  doc: number,
  searchIndex: SearchIndex,
  stats: ExecutionStats
): number {
  if (!prefix || !preceding.length) return 0;
  const inverted = index.fields[field];
  const predLists = preceding.map((tok) => {
    stats.postingListsTouched += 1;
    return inverted.terms.get(tok)?.byDoc.get(doc) || null;
  });
  if (predLists.some((row) => !row || !row.length)) return 0;
  const fieldTokens = tokensOf(searchIndex.documents[doc], field);
  const first = predLists[0]!;
  let count = 0;
  for (const start of first) {
    let pos = start;
    let ok = true;
    for (let t = 1; t < predLists.length; t++) {
      const want = pos + 1;
      const hit = nextAligned(predLists[t]!, want, stats);
      if (hit !== want) {
        ok = false;
        break;
      }
      pos = hit;
    }
    if (!ok) continue;
    stats.positionalComparisons += 1;
    stats.prefixNextTokenInspections += 1;
    const nextTok = fieldTokens[pos + 1] || "";
    if (nextTok.length > prefix.length && nextTok.startsWith(prefix)) count += 1;
  }
  return count;
}

function candidateDocs(index: PositionalIndex, tokens: string[], field: PhraseField, stats: ExecutionStats): number[] {
  if (!tokens.length) return [];
  let rarest: Map<number, number[]> | null = null;
  let rareSize = Infinity;
  for (const tok of tokens) {
    stats.postingListsTouched += 1;
    const postings = index.fields[field].terms.get(tok)?.byDoc;
    if (!postings || postings.size === 0) return [];
    if (postings.size < rareSize) {
      rareSize = postings.size;
      rarest = postings;
    }
  }
  return rarest ? [...rarest.keys()] : [];
}

function unionFirstTokenDocs(index: PositionalIndex, tokens: string[], field: PhraseField, stats: ExecutionStats): number[] {
  const docs = new Set<number>();
  for (const tok of tokens) {
    if (!tok) continue;
    stats.postingListsTouched += 1;
    const postings = index.fields[field].terms.get(tok)?.byDoc;
    if (!postings) continue;
    for (const d of postings.keys()) docs.add(d);
  }
  return [...docs];
}

function accumulateFieldHits(
  searchIndex: SearchIndex,
  perField: Map<PhraseField, number[]>,
  freq: (d: number, field: PhraseField) => number,
  stats: ExecutionStats,
  fields: PhraseField[]
): FieldPhraseHit[] {
  const byDoc = new Map<number, FieldPhraseHit>();
  let docsVisited = 0;
  for (const field of fields) {
    const row = perField.get(field) || [];
    docsVisited += row.length;
    stats.fieldDocProbes += row.length;
    for (const d of row) {
      const frequency = freq(d, field);
      if (!frequency) continue;
      let hit = byDoc.get(d);
      if (!hit) {
        hit = {
          document: searchIndex.documents[d],
          titleFrequency: 0,
          summaryFrequency: 0,
          bodyFrequency: 0,
        };
        byDoc.set(d, hit);
      }
      if (field === "title") hit.titleFrequency = frequency;
      else if (field === "summary") hit.summaryFrequency = frequency;
      else hit.bodyFrequency = frequency;
    }
  }
  stats.docsVisited += docsVisited;
  return [...byDoc.values()].filter((h) => h.titleFrequency + h.summaryFrequency + h.bodyFrequency > 0);
}

function fieldsOf(query: { field?: PhraseField }): PhraseField[] {
  return query.field ? [query.field] : PHRASE_FIELDS;
}

export function executePhraseQuery(
  query: PhraseQuery,
  searchIndex: SearchIndex,
  stats: ExecutionStats = emptyStats()
): FieldPhraseHit[] {
  const tokens = (query.tokens || []).filter(Boolean);
  if (tokens.length < 2) return [];
  const pos = positionalIndexOf(searchIndex);
  const fields = fieldsOf(query);
  const perField = new Map<PhraseField, number[]>();
  for (const field of fields) {
    perField.set(field, candidateDocs(pos, tokens, field, stats));
  }
  return accumulateFieldHits(
    searchIndex,
    perField,
    (d, field) => phraseFrequency(pos, tokens, field, d, stats),
    stats,
    fields
  );
}

export function executePhrasePrefixQuery(
  query: PhrasePrefixQuery,
  searchIndex: SearchIndex,
  stats: ExecutionStats = emptyStats()
): FieldPhraseHit[] {
  const preceding = (query.preceding || []).filter(Boolean);
  const prefix = String(query.prefix || "");
  if (!prefix || preceding.length < 1) return [];
  const pos = positionalIndexOf(searchIndex);
  const fields = fieldsOf(query);
  const perField = new Map<PhraseField, number[]>();
  for (const field of fields) {
    perField.set(field, candidateDocs(pos, preceding, field, stats));
  }
  return accumulateFieldHits(
    searchIndex,
    perField,
    (d, field) => phrasePrefixFrequency(pos, preceding, prefix, field, d, searchIndex, stats),
    stats,
    fields
  );
}

function matchTokensAt(
  fieldTokens: string[],
  pos: number,
  want: string[],
  prefixLast: boolean,
  stats: ExecutionStats
): boolean {
  if (!want.length) return pos <= fieldTokens.length;
  if (pos + want.length > fieldTokens.length) return false;
  const last = want.length - 1;
  for (let i = 0; i < last; i++) {
    stats.positionalComparisons += 1;
    if (fieldTokens[pos + i] !== want[i]) return false;
  }
  stats.positionalComparisons += 1;
  const got = fieldTokens[pos + last] || "";
  const need = want[last];
  if (!prefixLast) return got === need;
  stats.prefixNextTokenInspections += 1;
  return Boolean(need && got.length > need.length && got.startsWith(need));
}

function startPositionsForDoc(
  index: PositionalIndex,
  field: PhraseField,
  doc: number,
  firstTokens: string[],
  stats: ExecutionStats
): number[] {
  const starts = new Set<number>();
  for (const tok of firstTokens) {
    stats.postingListsTouched += 1;
    const row = index.fields[field].terms.get(tok)?.byDoc.get(doc);
    if (!row) continue;
    for (const p of row) starts.add(p);
  }
  return [...starts].sort((a, b) => a - b);
}

function graphFrequency(
  fieldTokens: string[],
  graph: WalkableTokenGraph,
  prefixLast: boolean,
  stats: ExecutionStats,
  startPositions: number[]
): number {
  const n = graph.length;
  if (n < 2 || !startPositions.length) return 0;
  /**
   * Suffix DP: canComplete(state, pos) does not depend on the prefix used to
   * arrive there. One memo for the whole field, not one memo per start.
   * Bound: O((V+1) * L * E) token compares, not O(paths).
   */
  const memo = new Map<string, boolean>();
  const consume = (state: number, pos: number): boolean => {
    if (state === n) return true;
    const key = `${state}\t${pos}`;
    const cached = memo.get(key);
    if (cached != null) {
      stats.graphDedupHits += 1;
      return cached;
    }
    stats.graphStatesVisited += 1;
    let ok = false;
    for (const edge of graph.edgesFrom[state] || []) {
      const lastHop = edge.to === n;
      if (matchTokensAt(fieldTokens, pos, edge.tokens, Boolean(prefixLast && lastHop), stats)) {
        if (consume(edge.to, pos + edge.tokens.length)) {
          ok = true;
          break;
        }
      }
    }
    memo.set(key, ok);
    return ok;
  };
  let count = 0;
  for (const start of startPositions) {
    if (consume(0, start)) count += 1;
  }
  return count;
}

/**
 * Direct DAG match against one token stream. Tests use this to prove
 * polynomial automaton evaluation without a corpus.
 */
export function matchTokenGraphFrequency(
  fieldTokens: string[],
  graph: WalkableTokenGraph,
  prefixLast: boolean,
  stats: ExecutionStats = emptyStats(),
  startPositions?: number[]
): number {
  const starts = startPositions || fieldTokens.map((_, i) => i);
  return graphFrequency(fieldTokens, graph, prefixLast, stats, starts);
}

function graphFirstTokens(graph: WalkableTokenGraph): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edgesFrom[0] || []) {
    const tok = edge.tokens[0];
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Execute a configured-form token DAG without materializing cartesian paths.
 * `prefixLast` applies PhrasePrefix semantics only to the hop that reaches
 * the final typed state.
 */
export function executeTokenGraph(
  graph: WalkableTokenGraph,
  searchIndex: SearchIndex,
  prefixLast: boolean,
  stats: ExecutionStats = emptyStats()
): FieldPhraseHit[] {
  if (!graph || graph.length < 2) return [];
  const pos = positionalIndexOf(searchIndex);
  const first = graphFirstTokens(graph);
  if (!first.length) return [];
  const perField = new Map<PhraseField, number[]>();
  for (const field of PHRASE_FIELDS) {
    perField.set(field, unionFirstTokenDocs(pos, first, field, stats));
  }
  return accumulateFieldHits(
    searchIndex,
    perField,
    (d, field) =>
      graphFrequency(
        tokensOf(searchIndex.documents[d], field),
        graph,
        prefixLast,
        stats,
        startPositionsForDoc(pos, field, d, first, stats)
      ),
    stats,
    PHRASE_FIELDS
  );
}

export function unionHits(rows: FieldPhraseHit[][]): FieldPhraseHit[] {
  const byId = new Map<string, FieldPhraseHit>();
  for (const list of rows) {
    for (const hit of list) {
      const id = hit.document.id;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { ...hit });
        continue;
      }
      prev.titleFrequency += hit.titleFrequency;
      prev.summaryFrequency += hit.summaryFrequency;
      prev.bodyFrequency += hit.bodyFrequency;
    }
  }
  return [...byId.values()];
}
