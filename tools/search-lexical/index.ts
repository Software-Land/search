/**
 * Public search-lexical compiler API.
 * Implementation lives in ./lib/compile.ts; this barrel freezes the v0.2.2 types.
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
  format: "search-v2-lexical-frequency";
  version: number;
  policy: {
    minN: number;
    maxN: number;
    minCollectionCount: number;
  };
  documents: Record<string, LexicalDocumentNgrams>;
}

export const COMPILER_VERSION: 1 = compilerVersion;
export const LEXICAL_FREQUENCY_FORMAT: "search-v2-lexical-frequency" = lexicalFrequencyFormat;
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
): LexicalFrequencyArtifact {
  return compileLexicalFrequencyImpl(input, opts);
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
