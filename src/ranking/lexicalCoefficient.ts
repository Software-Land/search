/**
 * Shared body-lexical score coefficient.
 *
 * scoreFeatures multiplies bodyLexicalMatch and configuredPrefixRecallScore
 * by this value. Prefix-only configured recall stores coverage, so its
 * contribution is coverage times this coefficient. The same coefficient
 * bounds a one-concept body hit in exact block skipping.
 *
 * Not a public ranking option.
 */
export const BODY_LEXICAL_SCORE_COEFFICIENT = 0.25;
