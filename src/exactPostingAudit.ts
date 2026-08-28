/**
 * Audit-only Stage-2B posting-work planner.
 *
 * This module does not change production retrieval. It walks the same compiled
 * posting lanes as the exhaustive Stage-1 retriever, records where visits come
 * from, and marks skippable work after the fact. Production still inspects
 * every posting entry.
 */
import { queryForms } from "./retrievers.js";
import { retrievalSourcesForDocument, identityTokens, shortTitleTokenPrefixStub, occupiedTitleJoins, hasConfiguredSequenceIntent } from "./retrieve.js";
import { allowPrefixMatch } from "./text.js";
import { isAllDigitToken } from "./versionForms.js";
import type { CompiledLexicalRuntime, CompiledTermRuntime } from "./lexicalIndex.js";
import type { AnalyzedQuery, IndexedDocument } from "./types.js";

export const POSTING_AUDIT_BLOCK_SIZE = 128;

export type PostingLane =
  | "surface"
  | "lemma"
  | "prefix"
  | "contextual";

export type PostingField = "title" | "body";

export type PostingLaneStats = {
  form: string;
  formKind: string;
  term: string;
  field: PostingField;
  lane: PostingLane;
  prefixExpanded: boolean;
  postingEntriesVisited: number;
  uniqueDocs: number;
  firstDiscoveryDocs: number;
  duplicateVisits: number;
  identicalListRewalkEntries: number;
  survivingFirstDiscovery: number;
  termLocalBlocks: number;
  termLocalBlocksSkippable: number;
};

export type ShadowPostingPlan = {
  postingEntriesVisited: number;
  uniqueDocOrdinals: number;
  duplicatePostingVisits: number;
  identicalListRewalkEntries: number;
  alreadySeenDocEntries: number;
  firstDiscoveryEntries: number;
  surfaceVisits: number;
  lemmaVisits: number;
  prefixVisits: number;
  titleVisits: number;
  bodyVisits: number;
  contextualVisits: number;
  versionDocVisits: number;
  queryFormsExpanded: number;
  termsExpanded: number;
  prefixTermsExpanded: number;
  distinctDocsMerged: number;
  exactMatchCount: number;
  termLocalBlocksVisited: number;
  termLocalBlocksSkippable: number;
  postingEntriesInSkippableBlocks: number;
  mergedOrdinalBlocksTouched: number;
  mergedOrdinalBlocksAllDuplicate: number;
  lanes: PostingLaneStats[];
};

export type PostingWorkAudit = {
  queryText: string;
  plan: ShadowPostingPlan;
  /** Surviving match ordinals from exhaustive provenance recheck. */
  exactMatchOrdinals: number[];
  /**
   * Membership from skipping identical already-walked posting arrays.
   * Must equal exactMatchOrdinals for the only currently proven skip rule.
   */
  identicalListSkipMatchOrdinals: number[];
  /**
   * Union if already-seen posting entries are ignored after first discovery.
   * Equal to exactMatchOrdinals by construction; measures fusion, not skip.
   */
  fusedMatchOrdinals: number[];
};

type LaneAcc = PostingLaneStats & {
  seen: Set<number>;
};

function lowerBoundNorm(arr: Array<{ norm: string }>, key: string) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].norm < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(values: string[], key: string) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function emptyLane(
  form: string,
  formKind: string,
  term: string,
  field: PostingField,
  lane: PostingLane,
  prefixExpanded: boolean
): LaneAcc {
  return {
    form,
    formKind,
    term,
    field,
    lane,
    prefixExpanded,
    postingEntriesVisited: 0,
    uniqueDocs: 0,
    firstDiscoveryDocs: 0,
    duplicateVisits: 0,
    identicalListRewalkEntries: 0,
    survivingFirstDiscovery: 0,
    termLocalBlocks: 0,
    termLocalBlocksSkippable: 0,
    seen: new Set(),
  };
}

function walkFlat(
  flat: number[],
  lane: LaneAcc,
  union: Set<number>,
  walked: WeakSet<number[]>,
  firstLane: Map<number, LaneAcc>,
  onDoc: (doc: number, first: boolean, identicalRewalk: boolean) => void
) {
  const identicalRewalk = walked.has(flat);
  walked.add(flat);
  let cursor = 0;
  let entries = 0;
  let blockFirst = true;
  let blockDuplicate = true;
  let blockEntries = 0;
  const finishBlock = () => {
    if (!blockEntries) return;
    lane.termLocalBlocks += 1;
    if (!blockFirst && blockDuplicate) {
      lane.termLocalBlocksSkippable += 1;
    }
    blockFirst = true;
    blockDuplicate = true;
    blockEntries = 0;
  };
  while (cursor < flat.length) {
    const doc = flat[cursor++];
    const tf = flat[cursor++];
    cursor += tf;
    entries += 1;
    lane.postingEntriesVisited += 1;
    lane.seen.add(doc);
    const first = !union.has(doc);
    if (first) {
      union.add(doc);
      firstLane.set(doc, lane);
      lane.firstDiscoveryDocs += 1;
      blockFirst = false;
    } else {
      lane.duplicateVisits += 1;
    }
    if (identicalRewalk) lane.identicalListRewalkEntries += 1;
    if (!first) blockDuplicate = blockDuplicate && true;
    else blockDuplicate = false;
    blockEntries += 1;
    if (blockEntries === POSTING_AUDIT_BLOCK_SIZE) finishBlock();
    onDoc(doc, first, identicalRewalk);
  }
  finishBlock();
  lane.uniqueDocs = lane.seen.size;
  return entries;
}

/**
 * Instrument compiled posting lanes without changing production retrieval.
 */
export function auditCompiledPostingWork(
  query: AnalyzedQuery,
  compiled: CompiledLexicalRuntime,
  documents: IndexedDocument[],
  queryText = ""
): PostingWorkAudit {
  const union = new Set<number>();
  const walked = new WeakSet<number[]>();
  const firstLane = new Map<number, LaneAcc>();
  const lanes: LaneAcc[] = [];
  const identicalSkipUnion = new Set<number>();
  let versionDocVisits = 0;
  let termsExpanded = 0;
  let prefixTermsExpanded = 0;

  function laneOf(
    form: string,
    formKind: string,
    term: string,
    field: PostingField,
    kind: PostingLane,
    prefixExpanded: boolean
  ) {
    const acc = emptyLane(form, formKind, term, field, kind, prefixExpanded);
    lanes.push(acc);
    return acc;
  }

  function accumulate(
    term: CompiledTermRuntime | undefined,
    field: PostingField,
    form: string,
    formKind: string,
    kind: PostingLane,
    prefixExpanded: boolean
  ) {
    if (!term) return;
    const flat = field === "title" ? term.title : term.body;
    if (!flat.length) return;
    termsExpanded += 1;
    const lane = laneOf(form, formKind, term.term, field, kind, prefixExpanded);
    walkFlat(flat, lane, union, walked, firstLane, (doc, _first, identicalRewalk) => {
      if (!identicalRewalk) identicalSkipUnion.add(doc);
    });
  }

  function accumulateLemma(
    terms: CompiledTermRuntime[] | undefined,
    field: PostingField,
    form: string,
    formKind: string
  ) {
    if (!terms?.length) return;
    for (const term of terms) {
      accumulate(term, field, form, formKind, "lemma", false);
    }
  }

  const forms = queryForms(query);
  const titleNorms = occupiedTitleJoins(query);
  const qNorms = titleNorms.length
    ? titleNorms
    : (() => {
        const qNorm = identityTokens(query).map((token) => token.normalized).join(" ");
        return qNorm ? [qNorm] : [];
      })();
  for (const qNorm of qNorms) {
    const exact = compiled.titleByNorm.get(qNorm);
    if (exact) {
      for (const pos of exact) {
        union.add(pos);
        identicalSkipUnion.add(pos);
      }
    }
    const sorted = compiled.sortedTitles;
    let i = lowerBoundNorm(sorted, qNorm);
    for (; i < sorted.length; i += 1) {
      const row = sorted[i];
      if (!row.norm.startsWith(qNorm)) break;
      union.add(row.pos);
      identicalSkipUnion.add(row.pos);
    }
  }

  const occupied = hasConfiguredSequenceIntent(query);
  for (const { form, kind } of forms) {
    const surface = compiled.bySurface.get(form);
    accumulate(surface, "title", form, kind, "surface", false);
    accumulate(surface, "body", form, kind, "surface", false);
    accumulateLemma(compiled.byLemma.get(form), "title", form, kind);
    accumulateLemma(compiled.byLemma.get(form), "body", form, kind);

    if (
      !(occupied && (kind === "acronym-form" || kind === "acronym-key")) &&
      !isAllDigitToken(form) &&
      form.length >= 3
    ) {
      let i = lowerBound(compiled.sortedTerms, form);
      while (i < compiled.sortedTerms.length) {
        const term = compiled.sortedTerms[i++];
        if (!term.startsWith(form)) break;
        if (term === form) continue;
        prefixTermsExpanded += 1;
        const row = compiled.bySurface.get(term);
        if (allowPrefixMatch(form, term)) {
          accumulate(row, "title", form, kind, "prefix", true);
        }
        if (!isAllDigitToken(term)) {
          accumulate(row, "body", form, kind, "prefix", true);
        }
      }
    }
  }

  const shortStub = shortTitleTokenPrefixStub(query);
  if (shortStub) {
    let i = lowerBound(compiled.sortedTerms, shortStub);
    while (i < compiled.sortedTerms.length) {
      const term = compiled.sortedTerms[i++];
      if (!term.startsWith(shortStub)) break;
      if (term === shortStub || isAllDigitToken(term)) continue;
      prefixTermsExpanded += 1;
      accumulate(compiled.bySurface.get(term), "title", shortStub, "token", "prefix", true);
    }
  }

  for (const token of query.tokens || []) {
    const posts = compiled.versionIndex.get(token.normalized);
    if (posts) {
      versionDocVisits += posts.length;
      for (const pos of posts) {
        union.add(pos);
        identicalSkipUnion.add(pos);
      }
    }
  }
  for (const span of query.dottedSpans || []) {
    const posts = compiled.versionIndex.get(span);
    if (posts) {
      versionDocVisits += posts.length;
      for (const pos of posts) {
        union.add(pos);
        identicalSkipUnion.add(pos);
      }
    }
  }

  const qTokens = query.tokens || [];
  if (qTokens.length >= 2) {
    const first = qTokens[0];
    const keys = [...new Set([first?.normalized, first?.lemma].filter((value): value is string => Boolean(value)))];
    for (const key of keys) {
      const surface = compiled.bySurface.get(key);
      if (surface) {
        accumulate(surface, "title", key, "token", "contextual", false);
      }
      for (const term of compiled.byLemma.get(key) || []) {
        accumulate(term, "title", key, "lemma", "contextual", false);
      }
    }
  }

  const exactMatchOrdinals: number[] = [];
  for (const pos of union) {
    const sources = retrievalSourcesForDocument(query, documents[pos]);
    if (!sources.length) continue;
    exactMatchOrdinals.push(pos);
  }
  exactMatchOrdinals.sort((a, b) => a - b);

  const surviving = new Set(exactMatchOrdinals);
  for (const lane of lanes) {
    for (const doc of lane.seen) {
      if (firstLane.get(doc) === lane && surviving.has(doc)) {
        lane.survivingFirstDiscovery += 1;
      }
    }
  }

  const identicalListSkipMatchOrdinals: number[] = [];
  for (const pos of identicalSkipUnion) {
    if (!retrievalSourcesForDocument(query, documents[pos]).length) continue;
    identicalListSkipMatchOrdinals.push(pos);
  }
  identicalListSkipMatchOrdinals.sort((a, b) => a - b);

  let postingEntriesVisited = 0;
  let duplicatePostingVisits = 0;
  let identicalListRewalkEntries = 0;
  let surfaceVisits = 0;
  let lemmaVisits = 0;
  let prefixVisits = 0;
  let titleVisits = 0;
  let bodyVisits = 0;
  let contextualVisits = 0;
  let termLocalBlocksVisited = 0;
  let termLocalBlocksSkippable = 0;
  const ordinalBlockTouched = new Set<number>();
  const ordinalBlockAllDuplicate = new Set<number>();
  const ordinalBlockHasFirst = new Set<number>();

  for (const lane of lanes) {
    postingEntriesVisited += lane.postingEntriesVisited;
    duplicatePostingVisits += lane.duplicateVisits;
    identicalListRewalkEntries += lane.identicalListRewalkEntries;
    termLocalBlocksVisited += lane.termLocalBlocks;
    termLocalBlocksSkippable += lane.termLocalBlocksSkippable;
    if (lane.lane === "surface") surfaceVisits += lane.postingEntriesVisited;
    else if (lane.lane === "lemma") lemmaVisits += lane.postingEntriesVisited;
    else if (lane.lane === "prefix") prefixVisits += lane.postingEntriesVisited;
    else contextualVisits += lane.postingEntriesVisited;
    if (lane.field === "title") titleVisits += lane.postingEntriesVisited;
    else bodyVisits += lane.postingEntriesVisited;
    for (const doc of lane.seen) {
      const block = Math.floor(doc / POSTING_AUDIT_BLOCK_SIZE);
      ordinalBlockTouched.add(block);
      if (firstLane.get(doc) === lane) ordinalBlockHasFirst.add(block);
    }
  }
  for (const block of ordinalBlockTouched) {
    if (!ordinalBlockHasFirst.has(block)) ordinalBlockAllDuplicate.add(block);
  }

  const firstDiscoveryEntries = postingEntriesVisited - duplicatePostingVisits;
  const plan: ShadowPostingPlan = {
    postingEntriesVisited,
    uniqueDocOrdinals: union.size,
    duplicatePostingVisits,
    identicalListRewalkEntries,
    alreadySeenDocEntries: duplicatePostingVisits,
    firstDiscoveryEntries,
    surfaceVisits,
    lemmaVisits,
    prefixVisits,
    titleVisits,
    bodyVisits,
    contextualVisits,
    versionDocVisits,
    queryFormsExpanded: forms.length,
    termsExpanded,
    prefixTermsExpanded,
    distinctDocsMerged: union.size,
    exactMatchCount: exactMatchOrdinals.length,
    termLocalBlocksVisited,
    termLocalBlocksSkippable,
    postingEntriesInSkippableBlocks: lanes.reduce((sum, lane) => (
      sum + lane.termLocalBlocksSkippable * POSTING_AUDIT_BLOCK_SIZE
    ), 0),
    mergedOrdinalBlocksTouched: ordinalBlockTouched.size,
    mergedOrdinalBlocksAllDuplicate: ordinalBlockAllDuplicate.size,
    lanes: lanes.map(({ seen: _seen, ...stats }) => stats),
  };

  return {
    queryText,
    plan,
    exactMatchOrdinals,
    identicalListSkipMatchOrdinals,
    fusedMatchOrdinals: exactMatchOrdinals,
  };
}

export function postingAuditSummary(audit: PostingWorkAudit) {
  const { plan } = audit;
  return {
    query: audit.queryText,
    totalPostingVisits: plan.postingEntriesVisited,
    uniqueDocOrdinals: plan.uniqueDocOrdinals,
    duplicatePostingVisits: plan.duplicatePostingVisits,
    identicalListRewalkEntries: plan.identicalListRewalkEntries,
    surfaceVisits: plan.surfaceVisits,
    lemmaVisits: plan.lemmaVisits,
    prefixVisits: plan.prefixVisits,
    titleVisits: plan.titleVisits,
    bodyVisits: plan.bodyVisits,
    contextualVisits: plan.contextualVisits,
    versionDocVisits: plan.versionDocVisits,
    queryFormsExpanded: plan.queryFormsExpanded,
    termsExpanded: plan.termsExpanded,
    prefixTermsExpanded: plan.prefixTermsExpanded,
    exactMatchCount: plan.exactMatchCount,
    termLocalBlocksVisited: plan.termLocalBlocksVisited,
    termLocalBlocksSkippable: plan.termLocalBlocksSkippable,
    mergedOrdinalBlocksTouched: plan.mergedOrdinalBlocksTouched,
    mergedOrdinalBlocksAllDuplicate: plan.mergedOrdinalBlocksAllDuplicate,
    identicalListSkipExact: arraysEqual(
      audit.exactMatchOrdinals,
      audit.identicalListSkipMatchOrdinals
    ),
  };
}

function arraysEqual(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function estimateTermLocalBlockMetadataBytes(postingEntries: number, blockSize = POSTING_AUDIT_BLOCK_SIZE) {
  const blocks = Math.ceil(postingEntries / blockSize);
  // minOrdinal, maxOrdinal, entryCount as three uint32 fields per block.
  return blocks * 12;
}

export function estimateDocBlockSideIndexBytes(
  documentCount: number,
  termCount: number,
  blockSize = POSTING_AUDIT_BLOCK_SIZE
) {
  const blocks = Math.ceil(documentCount / blockSize);
  // Presence bit per term per block is the dense upper bound; too large for
  // browsers. Compact posting-oriented summaries above are the realistic unit.
  const denseBits = blocks * termCount;
  return {
    documentBlocks: blocks,
    densePresenceBytes: Math.ceil(denseBits / 8),
    termLocalMinMaxCountBytes: estimateTermLocalBlockMetadataBytes(termCount * blockSize, blockSize),
  };
}
