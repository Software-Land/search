/**
 * Public and internal search-enrichment contracts.
 */

export type InferenceTask = "propose-expansion" | "adjudicate-abbreviation" | "discover-equivalences";

export type InferenceRelation = "initialism" | "acronym" | "alias" | "reject";

export interface InferenceAlternative {
  expansion: string[];
  note?: string;
}

export interface InferenceProposal {
  key: string;
  expansion: string[];
  relation: InferenceRelation;
  ambiguous: boolean;
  alternatives: InferenceAlternative[];
  aliases?: string[][];
  primary?: string | null;
  confidence?: number | null;
  rationale?: string;
  evidenceRefs?: Array<{ documentId?: string; field?: string; snippet?: string }>;
}

export interface LexicalInferenceRequest {
  schemaVersion: "search-enrichment-inference-v1";
  promptId: string;
  task: InferenceTask;
  /** Empty when task is propose-expansion for an attested phrase with no mined key. */
  key: string;
  /** Attested phrase tokens. For propose-expansion this is the phrase whose conventional acronym may be proposed. */
  minedExpansion: string[];
  /** Optional alias of minedExpansion for expansion-only provider requests. */
  phrase?: string[];
  evidence: Record<string, unknown>;
  alternatives: InferenceAlternative[];
  documentId?: string;
  title?: string;
  context?: string;
  observedAcronyms?: string[];
  knownEquivalences?: Array<{ key: string; expansion: string[] }>;
  maxProposals?: number;
}

export interface LexicalInferenceResponse {
  schemaVersion: "search-enrichment-inference-v1";
  proposals: InferenceProposal[];
}

export interface LexicalInferenceProvider {
  id: string;
  model?: string;
  temperature?: number;
  seed?: number | null;
  infer(request: LexicalInferenceRequest, options?: { signal?: AbortSignal }): Promise<LexicalInferenceResponse>;
}

export interface EnrichmentCache {
  get(key: string): LexicalInferenceResponse | null;
  set(key: string, value: LexicalInferenceResponse): void;
}

export type ProposalDisposition =
  | "agree"
  | "disagree"
  | "ambiguous"
  | "invalid"
  | "model-only"
  | "rejected-by-model";

export interface EnrichmentProposalRecord {
  request: LexicalInferenceRequest;
  response: LexicalInferenceResponse;
  disposition: ProposalDisposition;
  autoAccepted: boolean;
  cacheHit: boolean;
  reasons: string[];
}

export interface EnrichCorpusOptions {
  decisions?: unknown;
  previousInspection?: unknown;
  provider: LexicalInferenceProvider;
  cache?: EnrichmentCache | null;
  cacheDir?: string;
  autoAcceptVerified?: boolean;
  timeoutMs?: number;
  maxOpportunities?: number;
  /** Bounded model-assisted lexical discovery. Default true. */
  discover?: boolean;
  maxContextChars?: number;
  maxDiscoveryProposals?: number;
  maxDiscoveryDocuments?: number;
}

export interface EnrichCorpusResult {
  analysis: unknown;
  inspection: unknown;
  compiled: unknown;
  proposals: EnrichmentProposalRecord[];
  cacheStats: { hits: number; misses: number; writes: number };
}
