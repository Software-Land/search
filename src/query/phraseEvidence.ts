/**
 * Typed-surface phrase tokens. PhraseQuery execution lives in positionalQueries.
 *
 * Token/conjunction DF and selectivity are not ranking inputs. They belonged to
 * the rejected rare-phrase exclusivity experiments and are not computed here.
 */

import type { AnalyzedQuery } from "../types.js";

export function typedSurfacePhraseTokens(query: AnalyzedQuery): string[] {
  return (query.originalSurface || []).filter(Boolean);
}
