import { canonicalLexicalTokensFromQuery } from "../text/lexicalNormalize.js";
import { querySemanticFacts } from "../query/querySemantics.js";
import { scoreFeatures } from "./rank.js";
import { constraintSignature } from "./rankSignature.js";
import { levenshteinAtMost } from "../text/text.js";
import type {
  OptimizationSessionReason,
  SearchSessionCapabilities,
} from "../execution/executionSession.js";
import type {
  AnalyzedQuery,
  FeatureVector,
  RetrievalHit,
} from "../types.js";
import type { ExactPruningExtensionV1 } from "../indexing/lexicalIndex.js";

export type ExactCandidateBound = {
  hit: RetrievalHit;
  ordinal: number;
  signature: string;
  roundedScore: number;
  bodyPhraseCount: number;
};

export type ExactFeaturePruningStats = {
  mode: "exhaustive" | "feature-blocks";
  documentBlocksVisited: number;
  documentBlocksSkipped: number;
  boundedBlocksSkipped: number;
  postingBlocksVisited: number;
  postingBlocksSkipped: number;
  postingEntriesSkipped: number;
  documentsFullyEvaluated: number;
  documentsBoundRejected: number;
  signaturesEncountered: number;
  representativesRetained: number;
  pruningFallbackReason: string | null;
};

export type ExactFeaturePruningPlan = {
  unbounded: RetrievalHit[];
  retainedBounded: RetrievalHit[];
  bounded: ExactCandidateBound[];
  stats: ExactFeaturePruningStats;
};

type BoundContext = {
  phraseKey: string;
};

const boundContextCache = new WeakMap<AnalyzedQuery, BoundContext | null>();

export function roundedFeatureScore(features: Partial<FeatureVector>) {
  return Number(scoreFeatures(features).toFixed(6));
}

function bodyOnlySingleTokenContext(query: AnalyzedQuery): BoundContext | null {
  if (boundContextCache.has(query)) return boundContextCache.get(query) || null;
  const token = query.tokens?.[0];
  const lexical = query.lexicalTokens?.length ? query.lexicalTokens : query.tokens;
  const concept = query.concepts?.[0];
  const literal = token?.surfaceNormalized || token?.surface || "";
  const normalized = token?.normalized || "";
  const completion = querySemanticFacts(query).completion;
  const unsupportedCompletion = completion.vocabularyPrefix || completion.boundTrailing;
  const supported = Boolean(
    token &&
    query.tokens.length === 1 &&
    lexical.length === 1 &&
    query.concepts.length === 1 &&
    concept &&
    concept.kind === "term" &&
    concept.provenance === "surface" &&
    !concept.matchedForm?.length &&
    !concept.aliases?.length &&
    query.alternatives.length === 0 &&
    query.dottedSpans.length === 0 &&
    !unsupportedCompletion &&
    literal &&
    literal === token.surface &&
    literal === normalized &&
    !/^\d+$/.test(normalized) &&
    token.sources.every((source) => source === "surface")
  );
  const context = supported
    ? {
        phraseKey: canonicalLexicalTokensFromQuery(lexical)[0] || "",
      }
    : null;
  boundContextCache.set(query, context);
  return context;
}

/**
 * Exact local bound for the first Stage-2A class. A null result is a
 * fail-closed request for ordinary exhaustive feature evaluation.
 */
export function exactBodyOnlySingleTokenBound(
  query: AnalyzedQuery,
  hit: RetrievalHit,
  ordinal: number
): ExactCandidateBound | null {
  const context = bodyOnlySingleTokenContext(query);
  if (!context) return null;
  if (hit.relationship) return null;
  if (
    hit.retrievalSources.length !== 1 ||
    hit.retrievalSources[0] !== "body-lexical"
  ) {
    return null;
  }
  const token = query.tokens[0].normalized;
  const first = hit.document.firstToken || "";
  if (token.length <= 3 && (first === token || first.startsWith(token))) {
    return null;
  }
  if (token.length >= 5) {
    for (const titleToken of hit.document.titleTokens) {
      if (
        titleToken === token ||
        Math.abs(titleToken.length - token.length) > 2
      ) {
        continue;
      }
      const distance = levenshteinAtMost(token, titleToken, 2);
      if (distance > 0 && distance <= 2) return null;
    }
  }
  const frequency = hit.document.lexicalFrequency;
  const bodyPhraseCount =
    context.phraseKey &&
    frequency &&
    Number.isFinite(frequency[context.phraseKey])
      ? frequency[context.phraseKey]
      : 0;
  const exactFeatures: Partial<FeatureVector> = {
    bodyLexicalMatch: 1,
    lexicalConceptCoverage: 1,
    coverageConceptCount: 1,
    bodyPhraseCount,
    queryTokenCount: 1,
    relevanceKind: "direct",
    directClass: "weak",
  };
  return {
    hit,
    ordinal,
    signature: constraintSignature(exactFeatures),
    roundedScore: roundedFeatureScore(exactFeatures),
    bodyPhraseCount,
  };
}

function compareBoundCandidates(a: ExactCandidateBound, b: ExactCandidateBound) {
  if (a.roundedScore !== b.roundedScore) return b.roundedScore - a.roundedScore;
  if (b.bodyPhraseCount !== a.bodyPhraseCount) return b.bodyPhraseCount - a.bodyPhraseCount;
  return a.hit.document.id < b.hit.document.id
    ? -1
    : a.hit.document.id > b.hit.document.id
      ? 1
      : 0;
}

function canSkipSignatureBlock(
  current: ExactCandidateBound[] | undefined,
  incoming: ExactCandidateBound[],
  requiredDepth: number
) {
  if (requiredDepth <= 0) return true;
  if (!current || current.length < requiredDepth) return false;
  const bestIncoming = incoming.slice().sort(compareBoundCandidates)[0];
  const worstRetained = current[current.length - 1];
  return compareBoundCandidates(bestIncoming, worstRetained) >= 0;
}

function insertRepresentative(
  retained: Map<string, ExactCandidateBound[]>,
  candidate: ExactCandidateBound,
  requiredDepth: number
) {
  if (requiredDepth <= 0) return;
  const current = retained.get(candidate.signature) || [];
  current.push(candidate);
  current.sort(compareBoundCandidates);
  if (current.length > requiredDepth) current.length = requiredDepth;
  retained.set(candidate.signature, current);
}

export function planExactFeaturePruning({
  retrieved,
  query,
  requiredDepth,
  extension,
}: {
  retrieved: RetrievalHit[];
  query: AnalyzedQuery;
  requiredDepth: number;
  extension: ExactPruningExtensionV1;
}): ExactFeaturePruningPlan {
  type Block = {
    bounded: ExactCandidateBound[];
    unbounded: RetrievalHit[];
  };
  const blocks = new Map<number, Block>();
  const unbounded: RetrievalHit[] = [];
  const bounded: ExactCandidateBound[] = [];
  const documentCount =
    extension.boundaries[extension.boundaries.length - 1] || 0;
  for (const hit of retrieved) {
    const ordinal = hit.documentOrdinal;
    if (
      ordinal === undefined ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= documentCount
    ) {
      unbounded.push(hit);
      continue;
    }
    const blockIndex = Math.floor(ordinal / extension.blockSize);
    let block = blocks.get(blockIndex);
    if (!block) {
      block = { bounded: [], unbounded: [] };
      blocks.set(blockIndex, block);
    }
    const candidate = exactBodyOnlySingleTokenBound(query, hit, ordinal);
    if (candidate) {
      bounded.push(candidate);
      block.bounded.push(candidate);
    } else {
      unbounded.push(hit);
      block.unbounded.push(hit);
    }
  }

  const retained = new Map<string, ExactCandidateBound[]>();
  let boundedBlocksSkipped = 0;
  for (const blockIndex of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(blockIndex) as Block;
    const bySignature = new Map<string, ExactCandidateBound[]>();
    for (const candidate of block.bounded) {
      const list = bySignature.get(candidate.signature);
      if (list) list.push(candidate);
      else bySignature.set(candidate.signature, [candidate]);
    }
    const skipBounded =
      bySignature.size > 0 &&
      [...bySignature].every(([signature, incoming]) =>
        canSkipSignatureBlock(
          retained.get(signature),
          incoming,
          requiredDepth
        )
      );
    if (skipBounded) {
      boundedBlocksSkipped += 1;
      continue;
    }
    for (const candidate of block.bounded) {
      insertRepresentative(retained, candidate, requiredDepth);
    }
  }

  const retainedBounds = [...retained.values()].flat();
  const retainedIds = new Set(retainedBounds.map((candidate) => candidate.hit.document.id));
  const retainedBounded = retrieved.filter((hit) => retainedIds.has(hit.document.id));
  const documentBlocksSkipped = [...blocks.values()].filter((block) => {
    if (block.unbounded.length) return false;
    return block.bounded.length > 0 &&
      block.bounded.every((candidate) => !retainedIds.has(candidate.hit.document.id));
  }).length;
  return {
    unbounded,
    retainedBounded,
    bounded,
    stats: {
      mode: bounded.length ? "feature-blocks" : "exhaustive",
      documentBlocksVisited: blocks.size,
      documentBlocksSkipped,
      boundedBlocksSkipped,
      postingBlocksVisited: 0,
      postingBlocksSkipped: 0,
      postingEntriesSkipped: 0,
      documentsFullyEvaluated: unbounded.length + retainedBounded.length,
      documentsBoundRejected: bounded.length - retainedBounded.length,
      signaturesEncountered: retained.size,
      representativesRetained: retainedBounded.length,
      pruningFallbackReason: bounded.length ? null : "no-provable-candidates",
    },
  };
}

export type FeatureBlockPruningFallbackReason =
  | OptimizationSessionReason
  | "missing-pruning-extension";

/**
 * Stage-2A feature-block session gate. Packed search has a different retriever
 * check, a different all-strong guard, and extra explain/collector reasons.
 * Do not reuse packedSearchFallbackReason here.
 */
export function featureBlockPruningFallbackReason({
  session,
  compiledIndexedRetriever,
  hasExactPruningRuntime,
  relationshipStrategy,
}: {
  session: SearchSessionCapabilities;
  compiledIndexedRetriever: boolean;
  hasExactPruningRuntime: boolean;
  relationshipStrategy: string;
}): FeatureBlockPruningFallbackReason | null {
  if (session.exactDiagnostics) return "exact-diagnostics";
  if (session.exhaustivePruning) return "explicit-exhaustive";
  if (!compiledIndexedRetriever) return "unsupported-retriever";
  if (!hasExactPruningRuntime) return "missing-pruning-extension";
  if (session.retrievalScoreWeighted) return "retrieval-score-weight";
  if (relationshipStrategy !== "none" && session.allStrongRelationships) {
    return "all-strong-relationships";
  }
  return null;
}

export function exhaustiveFeaturePruningStats(
  documentCount: number,
  reason: string
): ExactFeaturePruningStats {
  return {
    mode: "exhaustive",
    documentBlocksVisited: 0,
    documentBlocksSkipped: 0,
    boundedBlocksSkipped: 0,
    postingBlocksVisited: 0,
    postingBlocksSkipped: 0,
    postingEntriesSkipped: 0,
    documentsFullyEvaluated: documentCount,
    documentsBoundRejected: 0,
    signaturesEncountered: 0,
    representativesRetained: 0,
    pruningFallbackReason: reason,
  };
}
