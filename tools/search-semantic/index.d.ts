/**
 * Public Node API for the optional Python semantic compiler.
 * Search Core does not import this module.
 */

export const SEMANTIC_ROOT: string;
export const SEMANTIC_BUILDER: string;
export const SEMANTIC_REQUIREMENTS: string;
export const SEMANTIC_REQUIREMENTS_EMBED: string;
export const DEFAULT_METHOD: "combined";
export const DEFAULT_REPRESENTATION: string;
export const DEFAULT_TOP_K: number;
export const DEFAULT_MIN_SCORE: number;
export const DEFAULT_MODEL: string;

export type SemanticMethod = "lexical" | "embedding" | "combined";

export interface EnsureSemanticEnvironmentOptions {
  method?: SemanticMethod;
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
   * Path of the written `search-v2-relationships` v1 JSON.
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
export function ensureSemanticEnvironment(
  opts?: EnsureSemanticEnvironmentOptions
): Promise<{ python: string; venvDir: string | null }>;
export function compileSemantic(input: unknown, opts?: CompileSemanticOptions): Promise<CompileSemanticResult>;
