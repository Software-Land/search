/**
 * Typed-surface phrase helpers. Result-set collapse is not default Core
 * behavior. Optional restriction is `resultCollector: "complete-interpretation"`.
 */

import { typedSurfacePhraseTokens } from "./phraseEvidence.js";
import { sequencePresent } from "./retrieve.js";
import type { AnalyzedQuery, IndexedDocument } from "./types.js";

export function typedPhraseTokens(query: AnalyzedQuery): string[] {
  return typedSurfacePhraseTokens(query);
}

export function documentHasExactTypedPhrase(tokens: string[], doc: IndexedDocument): boolean {
  if (!tokens.length) return false;
  return (
    sequencePresent(tokens, doc.titleTokens) ||
    sequencePresent(tokens, doc.summaryTokens || []) ||
    sequencePresent(tokens, doc.bodyTokens)
  );
}
