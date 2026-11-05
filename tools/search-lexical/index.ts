/**
 * Public search-lexical compiler API.
 * Frequency implementation lives in ./lib/compile.ts. The positional compiler
 * emits a `search-lexical-index` artifact with schema version 1 and shares
 * Core's analyzer implementation through the built output.
 */
import {
  COMPILER_VERSION as compilerVersion,
  DEFAULT_LEXICAL_POLICY as defaultLexicalPolicy,
  LEXICAL_FREQUENCY_FORMAT as lexicalFrequencyFormat,
  attachLexicalFrequency as attachLexicalFrequencyImpl,
  compileLexicalFrequency as compileLexicalFrequencyImpl,
  lookupNgramCount as lookupNgramCountImpl,
  resolveLexicalPolicy as resolveLexicalPolicyImpl,
  saturatingFrequency as saturatingFrequencyImpl,
} from "./lib/compile.js";
import * as lexicalIndexRuntime from "../../dist/indexing/lexicalIndex.js";

const compileLexicalIndexImpl = lexicalIndexRuntime.compileLexicalIndex;
const lexicalIndexFormat = lexicalIndexRuntime.LEXICAL_INDEX_FORMAT;
const lexicalIndexVersion = lexicalIndexRuntime.LEXICAL_INDEX_VERSION;

export interface LexicalPolicy {
  minN?: number;
  maxN?: number;
  minCollectionCount?: number;
}

export interface LexicalCompileOptions {
  lemma?: (token: string) => string;
  policy?: LexicalPolicy;
}

export interface LexicalDocumentNgrams {
  ngrams: Record<string, number>;
}

export interface LexicalFrequencyArtifact {
  format: "search-lexical-frequency" | "search-v2-lexical-frequency";
  version: number;
  policy: {
    minN: number;
    maxN: number;
    minCollectionCount: number;
  };
  documents: Record<string, LexicalDocumentNgrams>;
}

export interface LexicalIndexArtifact {
  format: "search-lexical-index" | "search-v2-lexical-index";
  version: 1;
  compatibility: {
    core: string;
    analyzer: string;
    schema: [string, string];
  };
  corpus: {
    documentCount: number;
    fingerprint: string;
  };
  integrity: string;
  /** Versioned opaque payload. Posting internals are not a public API. */
  data: unknown;
}

export interface LexicalIndexCompileOptions {
  schema?: Record<string, { type: "text"; role?: "title" | "body" }>;
  lemma?: (token: string) => string;
  /**
   * Required with `lemma`. Use the same deterministic identity exposed by the
   * runtime morphology plugin.
   */
  analyzerId?: string;
}

export const COMPILER_VERSION: 1 = compilerVersion;
export const LEXICAL_FREQUENCY_FORMAT: "search-lexical-frequency" = lexicalFrequencyFormat;
export const LEXICAL_INDEX_FORMAT: "search-lexical-index" = lexicalIndexFormat;
export const LEXICAL_INDEX_VERSION: 1 = lexicalIndexVersion;
export const DEFAULT_LEXICAL_POLICY: {
  readonly minN: 1;
  readonly maxN: 2;
  readonly minCollectionCount: 2;
} = defaultLexicalPolicy;

export function resolveLexicalPolicy(policy?: LexicalPolicy | null): {
  minN: number;
  maxN: number;
  minCollectionCount: number;
} {
  return resolveLexicalPolicyImpl(policy);
}

export function compileLexicalFrequency(
  input?: unknown,
  opts?: LexicalCompileOptions
): LexicalFrequencyArtifact & { format: "search-lexical-frequency" } {
  return compileLexicalFrequencyImpl(input, opts) as LexicalFrequencyArtifact & { format: "search-lexical-frequency" };
}

export function compileLexicalIndex(
  input?: unknown,
  { schema, lemma, analyzerId }: LexicalIndexCompileOptions = {}
): LexicalIndexArtifact & { format: "search-lexical-index" } {
  if (typeof lemma === "function" && !analyzerId) {
    throw new Error("compileLexicalIndex requires analyzerId when lemma is supplied");
  }
  const plugins =
    typeof lemma === "function"
      ? [{ name: "lexical-compiler", lemma, indexIdentity: analyzerId }]
      : [];
  return compileLexicalIndexImpl(input, {
    schema,
    plugins,
    analyzer: analyzerId,
  }) as LexicalIndexArtifact & { format: "search-lexical-index" };
}

export function attachLexicalFrequency<T extends { id?: unknown }>(
  documents: T[],
  artifact: LexicalFrequencyArtifact | null | undefined
): T[] {
  return attachLexicalFrequencyImpl(documents, artifact);
}

export function lookupNgramCount(
  ngrams: Record<string, number> | null | undefined,
  key: string
): number {
  return lookupNgramCountImpl(ngrams, key);
}

export function saturatingFrequency(count: number): number {
  return saturatingFrequencyImpl(count);
}
