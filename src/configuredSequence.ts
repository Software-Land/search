import { allowPrefixMatch } from "./text.js";
import type {
  ConfiguredPrefixSpan,
  ConfiguredSpan,
  DictionaryEntry,
  DictionarySequence,
  QueryToken,
  SearchPlugin,
} from "./types.js";

export type { ConfiguredPrefixSpan, ConfiguredSpan };

/**
 * Unique complete-query alignment to trusted configured sequences
 * (key, canonical expansion, aliases). Same-key multi-sequence matches
 * are not ambiguity. Distinct keys fail closed. Typed tokens are never
 * rewritten here; callers project canonical expansion as lexical intent.
 */
export interface ConfiguredSequenceIntent {
  key: string;
  expansion: string[];
  matchedKinds: string[];
}

export type ConfiguredSequenceResolution =
  | {
      status: "unique";
      intent: ConfiguredSequenceIntent;
      entry: DictionaryEntry;
      usedPrefix: boolean;
    }
  | { status: "ambiguous"; keys: string[] }
  | { status: "none" };

function tokenForms(tok: QueryToken): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const form = String(value || "").toLowerCase();
    if (form && !out.includes(form)) out.push(form);
  };
  add(tok.surfaceNormalized || tok.surface);
  add(tok.normalized);
  add(tok.lemma);
  return out;
}

function alignsExact(tok: QueryToken, want: string): boolean {
  if (!want) return false;
  for (const form of tokenForms(tok)) {
    if (form === want) return true;
  }
  return false;
}

function alignsNonLast(tok: QueryToken, want: string): boolean {
  if (alignsExact(tok, want)) return true;
  for (const form of tokenForms(tok)) {
    if (form.length >= want.length) continue;
    if (allowPrefixMatch(form, want)) return true;
  }
  return false;
}

function alignsLast(tok: QueryToken, want: string): boolean {
  if (alignsExact(tok, want)) return true;
  for (const form of tokenForms(tok)) {
    if (!form || form.length >= want.length) continue;
    if (want.startsWith(form)) return true;
  }
  return false;
}

/**
 * A 1-token alias that is just one word of a multi-token expansion is not a
 * trusted complete-query sequence (bare `security` is not appsec).
 */
function isSingleExpansionWordAlias(seq: DictionarySequence): boolean {
  if (seq.kind !== "alias") return false;
  const key = seq.entry?.key;
  const expansion = (seq.entry?.expansion || []).filter((f) => f && f !== key && !/^\d+$/.test(f));
  const tokens = seq.tokens || [];
  return expansion.length >= 2 && tokens.length === 1 && expansion.includes(tokens[0]);
}

function alignsKey(tok: QueryToken, want: string): boolean {
  if (!want) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed === want) return true;
  if (tok.normalized === want) return true;
  return false;
}

function sequenceAligns(tokens: QueryToken[], seq: DictionarySequence): { ok: boolean; usedPrefix: boolean } {
  const want = seq.tokens || [];
  if (!want.length || want.length !== tokens.length) return { ok: false, usedPrefix: false };
  if (seq.kind === "key") {
    if (tokens.length !== 1 || !alignsKey(tokens[0], want[0])) return { ok: false, usedPrefix: false };
    return { ok: true, usedPrefix: false };
  }
  let usedPrefix = false;
  for (let i = 0; i < want.length; i++) {
    const tok = tokens[i];
    const target = want[i];
    const isLast = i === want.length - 1;
    if (isLast) {
      if (alignsExact(tok, target)) continue;
      if (!alignsLast(tok, target)) return { ok: false, usedPrefix };
      usedPrefix = true;
      continue;
    }
    if (alignsExact(tok, target)) continue;
    if (!alignsNonLast(tok, target)) return { ok: false, usedPrefix };
    usedPrefix = true;
  }
  return { ok: true, usedPrefix };
}

/**
 * O(configured sequences × query tokens). Independent of corpus size.
 */
export function resolveConfiguredSequence(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredSequenceResolution {
  if (!dict?.sequences?.length || !tokens.length) return { status: "none" };
  const matches: Array<{ seq: DictionarySequence; usedPrefix: boolean }> = [];
  const keys = new Set<string>();
  for (const seq of dict.sequences) {
    if (!seq?.entry?.key || !seq.tokens?.length) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const aligned = sequenceAligns(tokens, seq);
    if (!aligned.ok) continue;
    matches.push({ seq, usedPrefix: aligned.usedPrefix });
    keys.add(seq.entry.key);
  }
  if (!matches.length) return { status: "none" };
  if (keys.size > 1) return { status: "ambiguous", keys: [...keys] };
  const key = matches[0].seq.entry.key;
  const entry = dict.byKey?.get(key) || matches[0].seq.entry;
  const matchedKinds = [...new Set(matches.map((m) => String(m.seq.kind || "")))].filter(Boolean);
  const usedPrefix = matches.some((m) => m.usedPrefix);
  return {
    status: "unique",
    intent: {
      key,
      expansion: [...(entry.expansion || [])],
      matchedKinds,
    },
    entry,
    usedPrefix,
  };
}

const SPAN_SEQUENCE_KINDS = new Set(["key", "expansion", "alias"]);

/**
 * Typed identity only. Prefix completion, lemma rewrite, and last-token stubs
 * must not create a configured span. `sequenceAligns` keeps prefix behavior
 * for whole-query callers.
 */
function exactTypedToken(tok: QueryToken, want: string): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  return typed === want;
}

function sequenceAlignsExactAt(tokens: QueryToken[], start: number, seq: DictionarySequence): boolean {
  const want = seq.tokens || [];
  const n = want.length;
  if (!n || start < 0 || start + n > tokens.length) return false;
  if (seq.kind === "key") {
    return n === 1 && exactTypedToken(tokens[start], want[0]);
  }
  if (seq.kind !== "expansion" && seq.kind !== "alias") return false;
  for (let j = 0; j < n; j++) {
    if (!exactTypedToken(tokens[start + j], want[j])) return false;
  }
  return true;
}

function spanKeyId(key: string, start: number, end: number) {
  return `${key}\t${start}\t${end}`;
}

/**
 * Exact configured key/expansion/alias windows. Independent of corpus size.
 * Same-key duplicate forms at the same indexes collapse. Distinct keys are
 * all returned; callers fail closed for topical activation.
 */
export function resolveConfiguredSpans(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredSpan[] {
  if (!dict?.sequences?.length || !tokens.length) return [];
  const grouped = new Map<string, { key: string; start: number; end: number; kinds: Set<string> }>();
  for (const seq of dict.sequences) {
    if (!seq?.entry?.key || !seq.tokens?.length) continue;
    if (!SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const n = seq.tokens.length;
    for (let start = 0; start <= tokens.length - n; start++) {
      if (!sequenceAlignsExactAt(tokens, start, seq)) continue;
      const end = start + n;
      const id = spanKeyId(seq.entry.key, start, end);
      let row = grouped.get(id);
      if (!row) {
        row = { key: seq.entry.key, start, end, kinds: new Set() };
        grouped.set(id, row);
      }
      if (seq.kind) row.kinds.add(String(seq.kind));
    }
  }
  return [...grouped.values()]
    .map((row) => ({
      key: row.key,
      start: row.start,
      end: row.end,
      matchedKinds: [...row.kinds].sort(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const PREFIX_SPAN_SEQUENCE_KINDS = new Set(["expansion", "alias"]);

function windowId(start: number, end: number) {
  return `${start}\t${end}`;
}

/**
 * Incomplete configured key/expansion/alias windows using the same
 * `sequenceAligns` prefix rules as whole-query resolution. n>=2 only.
 * Exact windows stay on `resolveConfiguredSpans`. Same-key forms at the
 * same indexes collapse. Distinct keys at the same indexes are dropped.
 */
export function resolveConfiguredPrefixSpans(
  tokens: QueryToken[],
  dict: SearchPlugin | null | undefined
): ConfiguredPrefixSpan[] {
  if (!dict?.sequences?.length || !tokens.length) return [];
  const exactWindows = new Set(
    resolveConfiguredSpans(tokens, dict).map((span) => windowId(span.start, span.end))
  );
  const grouped = new Map<
    string,
    { start: number; end: number; kinds: Set<string>; keys: Set<string> }
  >();
  for (const seq of dict.sequences) {
    if (!seq?.entry?.key || !seq.tokens?.length) continue;
    if (!PREFIX_SPAN_SEQUENCE_KINDS.has(String(seq.kind || ""))) continue;
    if (isSingleExpansionWordAlias(seq)) continue;
    const n = seq.tokens.length;
    if (n < 2) continue;
    for (let start = 0; start <= tokens.length - n; start++) {
      const aligned = sequenceAligns(tokens.slice(start, start + n), seq);
      if (!aligned.ok || !aligned.usedPrefix) continue;
      const end = start + n;
      if (exactWindows.has(windowId(start, end))) continue;
      const id = windowId(start, end);
      let row = grouped.get(id);
      if (!row) {
        row = { start, end, kinds: new Set(), keys: new Set() };
        grouped.set(id, row);
      }
      row.keys.add(seq.entry.key);
      if (seq.kind) row.kinds.add(String(seq.kind));
    }
  }
  return [...grouped.values()]
    .filter((row) => row.keys.size === 1)
    .map((row) => ({
      key: [...row.keys][0],
      start: row.start,
      end: row.end,
      matchedKinds: [...row.kinds].sort(),
      usedPrefix: true as const,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
