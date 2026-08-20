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

export declare const COMPILER_VERSION: 1;
export declare const LEXICAL_FREQUENCY_FORMAT: "search-v2-lexical-frequency";
export declare const DEFAULT_LEXICAL_POLICY: {
  readonly minN: 1;
  readonly maxN: 2;
  readonly minCollectionCount: 2;
};

export declare function resolveLexicalPolicy(
  policy?: LexicalPolicy | null
): {
  minN: number;
  maxN: number;
  minCollectionCount: number;
};

export declare function compileLexicalFrequency(
  input?: unknown,
  opts?: LexicalCompileOptions
): LexicalFrequencyArtifact;

export declare function attachLexicalFrequency<T extends { id?: unknown }>(
  documents: T[],
  artifact: LexicalFrequencyArtifact | null | undefined
): T[];

export declare function lookupNgramCount(
  ngrams: Record<string, number> | null | undefined,
  key: string
): number;

export declare function saturatingFrequency(count: number): number;
