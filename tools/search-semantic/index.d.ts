/**
 * Public Node API for the optional Python semantic compiler.
 * Search Core does not import this module.
 */

export const SEMANTIC_ROOT: string;
export const SEMANTIC_BUILDER: string;
export const SEMANTIC_REQUIREMENTS: string;
export const SEMANTIC_REQUIREMENTS_EMBED: string;
export const SEMANTIC_REQUIREMENTS_OPENAI: string;
export const DEFAULT_METHOD: "combined";
export const DEFAULT_REPRESENTATION: string;
export const DEFAULT_TOP_K: number;
export const DEFAULT_MIN_SCORE: number;
export const DEFAULT_MODEL: string;
export const DEFAULT_EMBEDDING_PROVIDER: "fastembed";
/** Documented initial OpenAI model. Used only when `embeddingProvider` is `"openai"`. */
export const OPENAI_EMBEDDING_MODEL: string;
/** Documented initial OpenAI dimensions for `text-embedding-3-large`. */
export const OPENAI_EMBEDDING_DIMENSIONS: number;

export type SemanticMethod = "lexical" | "embedding" | "combined";
export type EmbeddingProvider = "fastembed" | "openai";

export interface EnsureSemanticEnvironmentOptions {
  method?: SemanticMethod;
  embeddingProvider?: EmbeddingProvider;
  pythonPath?: string;
  venvDir?: string;
}

export interface CompileSemanticOptions {
  method?: SemanticMethod;
  representation?: string;
  topK?: number;
  minScore?: number;
  lexicalMinScore?: number;
  embeddingMinScore?: number;
  model?: string;
  /**
   * Offline embedding provider. `"fastembed"` is the default and does not read
   * OpenAI credentials. `"openai"` calls the Embeddings API while building the
   * relationship artifact. Runtime search never calls it.
   */
  embeddingProvider?: EmbeddingProvider;
  /** Required for OpenAI models other than `text-embedding-3-large`, which uses 3072. */
  dimensions?: number;
  /** Overrides `OPENAI_API_KEY` for this build. Not stored in the artifact or report. */
  apiKey?: string;
  /** Overrides `OPENAI_API_BASE`. Defaults to `https://api.openai.com/v1`. */
  apiBase?: string;
  pythonPath?: string;
  venvDir?: string;
  cacheDir?: string;
  /** Optional durable destination. When omitted, a unique temp-location file is created and returned. */
  outputPath?: string;
  reportPath?: string;
  precisionGate?: boolean;
  mutual?: boolean;
}

export interface CompileSemanticResult {
  artifact: Record<string, unknown>;
  report: Record<string, unknown> | null;
  /**
   * Path of the written `search-relationships` artifact with schema version 1.
   * When `outputPath` was omitted, this is a unique file under the system temp
   * directory that survives the call. The caller owns that file and may remove
   * it when finished. `compileSemantic()` does not delete a successful returned
   * default artifact.
   */
  outputPath: string;
  stdout: string;
}

export function semanticRoot(): string;
export function semanticBuilderPath(): string;
/** `undefined` or `null` selects FastEmbed. Any other value must be `fastembed` or `openai`. */
export function resolveEmbeddingProvider(value?: string | null): EmbeddingProvider;
export function ensureSemanticEnvironment(
  opts?: EnsureSemanticEnvironmentOptions
): Promise<{ python: string; venvDir: string | null }>;
export function compileSemantic(input: unknown, opts?: CompileSemanticOptions): Promise<CompileSemanticResult>;
