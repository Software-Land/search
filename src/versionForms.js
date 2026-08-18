/**
 * Dotted-numeric version aliases for Search V2.
 * Compact forms come only from dotted spans on the original surface
 * (e.g. "1.2" → "12"), never from joining independent digits or prefixes
 * of longer numerals (120 / 128) or hyphenated codes (AES-128).
 */

const DOTTED_NUMERIC_SPAN_RE = /(?:^|[^0-9])(\d+(?:\.\d+)+)(?![0-9])/g;

/** @param {unknown} [tok] */
export function isAllDigitToken(tok) {
  return typeof tok === "string" && /^\d+$/.test(tok);
}

/** @param {unknown} [surface] @returns {string[]} */
export function extractDottedSpans(surface) {
  const text = String(surface || "");
  const spans = [];
  const re = new RegExp(DOTTED_NUMERIC_SPAN_RE.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) spans.push(match[1]);
  }
  return spans;
}

/** @param {unknown} [surface] @returns {string[]} */
export function extractVersionCompactForms(surface) {
  const forms = [];
  const seen = new Set();
  for (const span of extractDottedSpans(surface)) {
    if (!span.includes(".")) continue;
    const compact = span.replace(/\./g, "");
    if (!isAllDigitToken(compact) || compact.length < 2) continue;
    if (seen.has(compact)) continue;
    seen.add(compact);
    forms.push(compact);
  }
  return forms;
}

/** @param {unknown} [qTok] @param {unknown} [versionCompactForms] */
export function queryTokenMatchesVersionCompact(qTok, versionCompactForms) {
  if (!isAllDigitToken(qTok)) return false;
  if (!Array.isArray(versionCompactForms) || versionCompactForms.length === 0) {
    return false;
  }
  return versionCompactForms.some((form) => form === qTok);
}

/** @param {unknown} [query] @param {unknown} [span] */
export function queryHasDottedSpan(query, span) {
  const qSpans = extractDottedSpans(query);
  return typeof span === "string" && qSpans.includes(span);
}
