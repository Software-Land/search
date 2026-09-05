/**
 * Dotted-numeric version aliases.
 * Compact forms come only from dotted spans on the original surface
 * (e.g. "1.2" → "12"), never from joining independent digits or prefixes
 * of longer numerals (120 / 128) or hyphenated codes (AES-128).
 *
 * tokenize() turns dots into spaces, so "1.2" becomes title tokens "1" and "2".
 * Those split components are not independent numeric title tokens (unlike HTTP/2).
 */

import { tokenizeWithRanges } from "./text.js";
import type { IndexedDocument } from "../types.js";

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

/**
 * True when an all-digit query token equals a component of a dotted numeric
 * span (the "2" in "1.2"). Distinct from compact version aliases ("12") and
 * from independent title tokens (HTTP/2).
 */
export function queryTokenMatchesDottedSpanComponent(qTok?: unknown, dottedSpans?: unknown): boolean {
  if (!isAllDigitToken(qTok) || typeof qTok !== "string") return false;
  if (!Array.isArray(dottedSpans) || dottedSpans.length === 0) return false;
  return dottedSpans.some((span) => {
    if (typeof span !== "string" || !span.includes(".")) return false;
    return span.split(".").filter(isAllDigitToken).includes(qTok);
  });
}

function dottedSpanRanges(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(DOTTED_NUMERIC_SPAN_RE.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    const span = match[1];
    if (!span) continue;
    const full = match[0];
    const start = match.index + (full.endsWith(span) ? full.length - span.length : 0);
    spans.push({ start, end: start + span.length });
  }
  return spans;
}

/**
 * Title-token indexes whose source range sits inside a dotted numeric span.
 * "TLS 1.2" marks the split "1" and "2". "HTTP/2" and "Chapter 1 and 2" mark none.
 */
export function dottedSpanComponentIndexes(title?: unknown): Set<number> {
  const text = String(title || "");
  const spans = dottedSpanRanges(text);
  const marked = new Set<number>();
  if (!spans.length) return marked;
  const ranges = tokenizeWithRanges(text);
  for (let i = 0; i < ranges.length; i++) {
    const { token, start, end } = ranges[i];
    if (!isAllDigitToken(token)) continue;
    for (const span of spans) {
      if (start >= span.start && end <= span.end) {
        marked.add(i);
        break;
      }
    }
  }
  return marked;
}

function markedIndexes(doc: Pick<IndexedDocument, "dottedSpanComponentIndexes"> | null | undefined) {
  return doc?.dottedSpanComponentIndexes || new Set<number>();
}

/** True when `tok` occurs as a title token outside any dotted numeric span. */
export function hasIndependentTitleToken(
  doc: Pick<IndexedDocument, "titleTokens" | "dottedSpanComponentIndexes"> | null | undefined,
  tok?: unknown
): boolean {
  if (typeof tok !== "string" || !tok || !doc?.titleTokens) return false;
  const marked = markedIndexes(doc);
  for (let i = 0; i < doc.titleTokens.length; i++) {
    if (doc.titleTokens[i] === tok && !marked.has(i)) return true;
  }
  return false;
}

/** True when `form` occurs as an independent title token or lemma. */
export function hasIndependentTitleForm(
  doc: Pick<IndexedDocument, "titleTokens" | "titleLemmas" | "dottedSpanComponentIndexes"> | null | undefined,
  form?: unknown
): boolean {
  if (typeof form !== "string" || !form || !doc?.titleTokens) return false;
  const marked = markedIndexes(doc);
  const lemmas = doc.titleLemmas || [];
  for (let i = 0; i < doc.titleTokens.length; i++) {
    if (marked.has(i)) continue;
    if (doc.titleTokens[i] === form || lemmas[i] === form) return true;
  }
  return false;
}

export function isDottedSpanComponentIndex(
  doc: Pick<IndexedDocument, "dottedSpanComponentIndexes"> | null | undefined,
  index: number
): boolean {
  return markedIndexes(doc).has(index);
}
