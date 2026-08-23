/**
 * Public search-enrichment API. Optional, build-time, never imported by Search Core.
 */
export {
  EnrichCorpusOptions,
  EnrichCorpusResult,
  EnrichmentCache,
  EnrichmentProposalRecord,
  InferenceProposal,
  LexicalInferenceProvider,
  LexicalInferenceRequest,
  LexicalInferenceResponse,
} from "./types.js";

export declare const INFERENCE_SCHEMA_VERSION: "search-enrichment-inference-v1";
export declare const PROMPT_ID: "search-enrichment-v2";
export declare const SYSTEM_PROMPT: string;

export declare class EnrichmentError extends Error {
  details: string[];
}

export declare function enrichCorpus(
  input?: unknown,
  opts?: import("./types.js").EnrichCorpusOptions
): Promise<import("./types.js").EnrichCorpusResult>;

export declare function createFunctionProvider(
  fn: (
    request: import("./types.js").LexicalInferenceRequest,
    options?: { signal?: AbortSignal }
  ) =>
    | import("./types.js").LexicalInferenceResponse
    | Promise<import("./types.js").LexicalInferenceResponse>,
  meta?: { id?: string; model?: string; temperature?: number; seed?: number | null }
): import("./types.js").LexicalInferenceProvider;

export declare function createOpenAICompatibleProvider(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  seed?: number | null;
  fetchImpl?: typeof fetch;
}): import("./types.js").LexicalInferenceProvider;

export declare function validateInferenceResponse(raw?: unknown): import("./types.js").LexicalInferenceResponse;
export declare function createFileCache(dir: string): import("./types.js").EnrichmentCache;
export declare function createMemoryCache(): import("./types.js").EnrichmentCache;
export declare function cacheKeyFor(
  request: import("./types.js").LexicalInferenceRequest,
  provider: Pick<import("./types.js").LexicalInferenceProvider, "id" | "model" | "temperature" | "seed">
): string;

export declare function requestFromPhrase(phrase: string[]): import("./types.js").LexicalInferenceRequest;
export declare function requestFromDocument(
  doc: { id: string; title?: string; body?: string },
  opts?: {
    maxContextChars?: number;
    maxProposals?: number;
    knownEquivalences?: Array<{ key: string; expansion: string[] }>;
  }
): import("./types.js").LexicalInferenceRequest;
