/**
 * Stage 3A: exact unread body-block skipping on the shared 128-document
 * ordinal grid. Stronger co-occurrence classes are evaluated first. The 1-of-k
 * body flood is skipped only after every pop>=2 class has been evaluated and
 * the weak representative stream is proven full. Missing or uncertain metadata
 * fails closed to exhaustive retrieval.
 */

import { throwIfAborted } from "./cancel.js";
import { REPEATED_BODY_PHRASE_MIN } from "./evidencePolicy.js";
import {
  EXACT_PRUNING_BLOCK_SIZE,
  type CompiledLexicalRuntime,
  type CompiledTermRuntime,
} from "./lexicalIndex.js";
import { lexicalPhraseKeyFromQuery } from "./lexicalNormalize.js";
import { allowPrefixMatch } from "./text.js";
import type { AnalyzedQuery, IndexedDocument, QueryConcept } from "./types.js";
import { isAllDigitToken } from "./versionForms.js";

export type Stage3AStats = {
  applied: boolean;
  fallbackReason: string | null;
  /**
   * Unique 128-document ordinal blocks with any query-term body presence.
   * Invariant: total = decoded + classifiedFromMasks.
   */
  postingBlocksTotal: number;
  /** Presence blocks whose body posting payloads were walked. */
  postingBlocksDecoded: number;
  /**
   * Presence blocks classified from exact-pruning-v2 bits without walking
   * body posting payloads.
   */
  postingBlocksClassifiedFromMasks: number;
  /**
   * Presence blocks that still contain skipped 1-of-k docs whose body
   * postings were never walked. Subset of classifiedFromMasks.
   */
  postingBlocksSkippedUnread: number;
  postingEntriesDecoded: number;
  evaluatedBodyOrdinals: number;
  skippedBodyOrdinals: number;
};

export type Stage3APlan = {
  bodyOrdinals: number[];
  stats: Stage3AStats;
};

const MASK_WORDS = 4;
const UNSUPPORTED_TOKEN_SOURCES = new Set([
  "typo-correction",
  "leet-decode",
  "repeat-collapse",
  "final-token-prefix",
  "contextual-completion",
  "configured-equivalence",
  "expansion",
]);

export function oneOfKBodyOnlyMaxRoundedScore(conceptCount: number) {
  const k = Math.max(1, conceptCount);
  const bodyLexicalMatch = Number((1 / k).toFixed(4));
  return Number((bodyLexicalMatch * 0.25).toFixed(6));
}

export function stage3AUnsupportedReason(query: AnalyzedQuery): string | null {
  const tokens = query.tokens || [];
  if (tokens.length < 2) return "token-count";
  if (query.alternatives?.length) return "alternatives";
  if (query.dottedSpans?.length) return "dotted-spans";
  const prefix = query.prefixCompletion;
  if (prefix?.completedToken || prefix?.canonicalToken) return "prefix-completion";
  if (query.contextualCompletion?.completedToken) return "contextual-completion";
  if ((query.topicalRecall?.forms || []).length) return "topical-recall";
  const concepts = query.concepts || [];
  if (concepts.some((concept) => concept.kind === "acronym")) return "acronym";
  const terms = concepts.filter((concept) => concept.kind === "term");
  if (terms.length < 2) return "term-concept-count";
  for (const concept of terms) {
    if (concept.expansion?.length || concept.aliases?.length) return "concept-expansion";
    if (concept.provenance && concept.provenance !== "surface" && concept.provenance !== "morphology") {
      return "concept-provenance";
    }
  }
  for (const token of tokens) {
    const normalized = String(token.normalized || "");
    if (!normalized) return "empty-token";
    if (isAllDigitToken(normalized)) return "numeric-token";
    if (token.completedToken) return "completed-token";
    const sources = token.sources || [];
    if (sources.some((source) => UNSUPPORTED_TOKEN_SOURCES.has(source))) return "token-sources";
  }
  return null;
}

function lowerBoundTerm(terms: string[], key: string) {
  let lo = 0;
  let hi = terms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (terms[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function iteratePostingDocs(flat: number[], visit: (doc: number) => void) {
  let cursor = 0;
  while (cursor < flat.length) {
    const doc = flat[cursor++];
    const tf = flat[cursor++];
    cursor += tf;
    visit(doc);
  }
}

function setPresenceBit(words: Uint32Array, documentCount: number, ordinal: number) {
  if (ordinal < 0 || ordinal >= documentCount) return;
  const block = Math.floor(ordinal / EXACT_PRUNING_BLOCK_SIZE);
  const bit = ordinal - block * EXACT_PRUNING_BLOCK_SIZE;
  const word = (bit / 32) | 0;
  words[block * MASK_WORDS + word] = (words[block * MASK_WORDS + word] | (1 << (bit % 32))) >>> 0;
}

function orTermPresence(
  dest: Uint32Array,
  term: CompiledTermRuntime,
  documentCount: number,
  stats: { postingEntriesDecoded: number; decodedOrdinalBlocks: Set<number> }
): boolean {
  const presence = term.bodyPresence;
  if (presence && presence.blockIndexes.length) {
    for (let i = 0; i < presence.blockIndexes.length; i++) {
      const destOff = presence.blockIndexes[i] * MASK_WORDS;
      const off = i * MASK_WORDS;
      dest[destOff] |= presence.words[off];
      dest[destOff + 1] |= presence.words[off + 1];
      dest[destOff + 2] |= presence.words[off + 2];
      dest[destOff + 3] |= presence.words[off + 3];
    }
    return true;
  }
  if (!term.body.length) return true;
  let minDoc = Infinity;
  let maxDoc = -1;
  iteratePostingDocs(term.body, (doc) => {
    stats.postingEntriesDecoded += 1;
    stats.decodedOrdinalBlocks.add(Math.floor(doc / EXACT_PRUNING_BLOCK_SIZE));
    if (doc < minDoc) minDoc = doc;
    if (doc > maxDoc) maxDoc = doc;
    setPresenceBit(dest, documentCount, doc);
  });
  if (minDoc === Infinity) return true;
  return Math.floor(minDoc / EXACT_PRUNING_BLOCK_SIZE) === Math.floor(maxDoc / EXACT_PRUNING_BLOCK_SIZE);
}

function collectConceptTerms(compiled: CompiledLexicalRuntime, concept: QueryConcept): CompiledTermRuntime[] {
  const out: CompiledTermRuntime[] = [];
  const seen = new Set<string>();
  const add = (term: CompiledTermRuntime | undefined) => {
    if (!term || seen.has(term.term)) return;
    seen.add(term.term);
    out.push(term);
  };
  const forms = [...new Set([concept.id, ...(concept.forms || [])].filter(Boolean))];
  for (const form of forms) {
    add(compiled.bySurface.get(form));
    for (const term of compiled.byLemma.get(form) || []) add(term);
    if (isAllDigitToken(form) || form.length < 3) continue;
    let i = lowerBoundTerm(compiled.sortedTerms, form);
    while (i < compiled.sortedTerms.length) {
      const name = compiled.sortedTerms[i++];
      if (!name.startsWith(form)) break;
      if (name === form || isAllDigitToken(name)) continue;
      const row = compiled.bySurface.get(name);
      if (!row) continue;
      if (allowPrefixMatch(form, name) || name.startsWith(form)) add(row);
    }
  }
  return out;
}

function nonemptyBlockCount(words: Uint32Array, nBlocks: number) {
  let count = 0;
  for (let b = 0; b < nBlocks; b++) {
    const o = b * MASK_WORDS;
    if (words[o] | words[o + 1] | words[o + 2] | words[o + 3]) count += 1;
  }
  return count;
}

function phraseCount(doc: IndexedDocument | undefined, phraseKey: string) {
  if (!doc || !phraseKey) return 0;
  const n = doc.lexicalFrequency?.[phraseKey];
  return Number.isFinite(n) ? Number(n) : 0;
}

function isWeakBodyPhrase(doc: IndexedDocument | undefined, phraseKey: string) {
  return phraseCount(doc, phraseKey) < REPEATED_BODY_PHRASE_MIN;
}

function unreadBlockSet(skipped: number[]) {
  const blocks = new Set<number>();
  for (const ordinal of skipped) blocks.add(Math.floor(ordinal / EXACT_PRUNING_BLOCK_SIZE));
  return blocks;
}

export function planStage3ABodyOrdinals({
  query,
  compiled,
  documents,
  titleOrdinals,
  requiredDepth,
  signal,
}: {
  query: AnalyzedQuery;
  compiled: CompiledLexicalRuntime;
  documents: IndexedDocument[];
  titleOrdinals: Set<number>;
  requiredDepth: number;
  signal?: AbortSignal;
}): Stage3APlan | null {
  const reason = stage3AUnsupportedReason(query);
  if (reason || !compiled.exactPruningV2) return null;
  const terms = (query.concepts || []).filter((concept) => concept.kind === "term");
  const n = documents.length;
  const nBlocks = Math.max(1, Math.ceil(n / EXACT_PRUNING_BLOCK_SIZE));
  const k = terms.length;
  const depth = Math.max(0, requiredDepth | 0);
  const decodeStats = { postingEntriesDecoded: 0, decodedOrdinalBlocks: new Set<number>() };
  const conceptMasks: Uint32Array[] = [];

  for (const concept of terms) {
    throwIfAborted(signal);
    const mask = new Uint32Array(nBlocks * MASK_WORDS);
    const contrib = collectConceptTerms(compiled, concept);
    if (!contrib.length) return null;
    for (const term of contrib) {
      if (!orTermPresence(mask, term, n, decodeStats)) return null;
    }
    if (!nonemptyBlockCount(mask, nBlocks)) return null;
    conceptMasks.push(mask);
  }

  const classes: number[][] = Array.from({ length: k + 1 }, () => []);
  for (let block = 0; block < nBlocks; block++) {
    throwIfAborted(signal);
    const blockStart = block * EXACT_PRUNING_BLOCK_SIZE;
    for (let bit = 0; bit < EXACT_PRUNING_BLOCK_SIZE; bit++) {
      const ordinal = blockStart + bit;
      if (ordinal >= n) break;
      const word = (bit / 32) | 0;
      const maskBit = 1 << (bit % 32);
      let pc = 0;
      for (let c = 0; c < k; c++) {
        if (conceptMasks[c][block * MASK_WORDS + word] & maskBit) pc += 1;
      }
      if (pc > 0) classes[pc].push(ordinal);
    }
  }

  const phraseKey = query.lexicalPhraseKey || lexicalPhraseKeyFromQuery(query.lexicalTokens || query.tokens);
  const evaluated = new Set<number>();
  // Conjunction / partial-conjunction classes can mint phrase and direct-class
  // signatures. Always evaluate pop>=2 before any 1-of-k skip proof.
  for (let pop = k; pop >= 2; pop--) {
    for (const ordinal of classes[pop] || []) evaluated.add(ordinal);
  }

  const countWeak = () => {
    let weak = 0;
    for (const ordinal of evaluated) {
      if (titleOrdinals.has(ordinal)) continue;
      if (isWeakBodyPhrase(documents[ordinal], phraseKey)) weak += 1;
    }
    return weak;
  };

  let weak = countWeak();
  const class1 = classes[1] || [];
  if (!(depth > 0 && weak >= depth)) {
    for (const ordinal of class1) {
      if (evaluated.has(ordinal) || titleOrdinals.has(ordinal)) continue;
      evaluated.add(ordinal);
      if (isWeakBodyPhrase(documents[ordinal], phraseKey)) weak += 1;
      if (depth > 0 && weak >= depth) break;
    }
  }

  const skippedBodyOrdinals = class1.filter(
    (ordinal) => !evaluated.has(ordinal) && !titleOrdinals.has(ordinal)
  );
  const bodyOrdinals = [...evaluated].filter((ordinal) => !titleOrdinals.has(ordinal)).sort((a, b) => a - b);
  const presenceBlocks: number[] = [];
  for (let b = 0; b < nBlocks; b++) {
    let any = 0;
    for (const mask of conceptMasks) {
      const o = b * MASK_WORDS;
      any |= mask[o] | mask[o + 1] | mask[o + 2] | mask[o + 3];
    }
    if (any) presenceBlocks.push(b);
  }
  const decoded = presenceBlocks.filter((b) => decodeStats.decodedOrdinalBlocks.has(b));
  const classifiedFromMasks = presenceBlocks.filter((b) => !decodeStats.decodedOrdinalBlocks.has(b));
  const skippedUnread = [...unreadBlockSet(skippedBodyOrdinals)].filter(
    (b) => !decodeStats.decodedOrdinalBlocks.has(b)
  );

  return {
    bodyOrdinals,
    stats: {
      applied: true,
      fallbackReason: null,
      postingBlocksTotal: presenceBlocks.length,
      postingBlocksDecoded: decoded.length,
      postingBlocksClassifiedFromMasks: classifiedFromMasks.length,
      postingBlocksSkippedUnread: skippedUnread.length,
      postingEntriesDecoded: decodeStats.postingEntriesDecoded,
      evaluatedBodyOrdinals: bodyOrdinals.length,
      skippedBodyOrdinals: skippedBodyOrdinals.length,
    },
  };
}
