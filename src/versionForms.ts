/**
 * Dotted-numeric version aliases.
 * Compact forms come only from dotted spans on the original surface
 * (e.g. "1.2" → "12"), never from joining independent digits or prefixes
 * of longer numerals (120 / 128) or hyphenated codes (AES-128).
 */

const DOTTED_NUMERIC_SPAN_RE = /(?:^|[^0-9])(\d+(?:\.\d+)+)(?![0-9])/g;

export function isAllDigitToken(tok?: unknown): boolean {
  return typeof tok === "string" && /^\d+$/.test(tok);
}

export function extractDottedSpans(surface?: unknown): string[] {
  const text = String(surface || "");
  const spans: string[] = [];
  const re = new RegExp(DOTTED_NUMERIC_SPAN_RE.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) spans.push(match[1]);
  }
  return spans;
}

export function extractVersionCompactForms(surface?: unknown): string[] {
  const forms: string[] = [];
  const seen = new Set<string>();
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

export function queryTokenMatchesVersionCompact(qTok?: unknown, versionCompactForms?: unknown): boolean {
  if (!isAllDigitToken(qTok)) return false;
  if (!Array.isArray(versionCompactForms) || versionCompactForms.length === 0) {
    return false;
  }
  return versionCompactForms.some((form) => form === qTok);
}

export function queryHasDottedSpan(query?: unknown, span?: unknown): boolean {
  const qSpans = extractDottedSpans(query);
  return typeof span === "string" && qSpans.includes(span);
}
