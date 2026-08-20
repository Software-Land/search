/**
 * Named evidence thresholds. Values are invariants, not ranking weights.
 */

/**
 * Coverage of 1 after extractFeatures rounding (`toFixed(4)`).
 * Used as "full query coverage".
 */
export const FULL_QUERY_COVERAGE = 0.999;

/**
 * Incidental overlap: the query covers strictly less than two thirds of its
 * concepts. Written as 2/3 so 0.6667 is not accidentally treated as incidental.
 */
export const TWO_THIRDS_QUERY_COVERAGE = 2 / 3;

/**
 * Standalone moderate title-prefix quality when coverage is not already full.
 */
export const MODERATE_TITLE_PREFIX_QUALITY = 0.5;

/**
 * Prefix-quality floor when query coverage is already full.
 * Full coverage is the strong signal; prefix tightness is a secondary check,
 * so this floor is lower than MODERATE_TITLE_PREFIX_QUALITY.
 */
export const STRONG_WITH_FULL_COVERAGE_TITLE_PREFIX_QUALITY = 0.4;

/**
 * Repeated compiled body-phrase evidence: at least this many occurrences of
 * the normalized multi-token phrase in the body field.
 */
export const REPEATED_BODY_PHRASE_MIN = 2;
