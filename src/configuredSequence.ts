import { allowPrefixMatch, DEFAULT_STOP } from "./text.js";
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

function exactTypedConfiguredKeys(tok: QueryToken, dict: SearchPlugin | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!dict?.sequences?.length || !tok) return keys;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed) return keys;
  for (const seq of dict.sequences) {
    if (!seq?.entry?.key || !seq.tokens?.length) continue;
    if (seq.tokens.includes(typed)) keys.add(seq.entry.key);
  }
  return keys;
}

/**
 * Exact configured-key occupancy. Typed identity first; a valid morphology
 * lemma (or canonical normalized form) may occupy the same key when it
 * equals that key exactly and the typed token is not already an exact
 * configured token of a different key (`https` must not also occupy `http`).
 * No prefix, typo, or synonym forms.
 */
export function tokenAlignsConfiguredKey(
  tok: QueryToken,
  want: string,
  dict?: SearchPlugin | null
): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed === want) return true;
  const lemma = String(tok.lemma || "").toLowerCase();
  if (tok.normalized !== want && lemma !== want) return false;
  for (const key of exactTypedConfiguredKeys(tok, dict)) {
    if (key !== want) return false;
  }
  return true;
}

function alignsKey(tok: QueryToken, want: string, dict?: SearchPlugin | null): boolean {
  return tokenAlignsConfiguredKey(tok, want, dict);
}

function sequenceAligns(
  tokens: QueryToken[],
  seq: DictionarySequence,
  dict?: SearchPlugin | null
): { ok: boolean; usedPrefix: boolean } {
  const want = seq.tokens || [];
  if (!want.length || want.length !== tokens.length) return { ok: false, usedPrefix: false };
  if (seq.kind === "key") {
    if (tokens.length !== 1 || !alignsKey(tokens[0], want[0], dict)) return { ok: false, usedPrefix: false };
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

const MIN_EXPANSION_PREFIX_TOKENS = 2;
const MIN_EXPANSION_PREFIX_COVERAGE = 2 / 3;

function uniqueResolution(
  entry: DictionaryEntry,
  matchedKinds: string[],
  usedPrefix: boolean
): ConfiguredSequenceResolution {
  return {
    status: "unique",
    intent: {
      key: entry.key,
      expansion: [...(entry.expansion || [])],
      matchedKinds,
    },
    entry,
    usedPrefix,
  };
}

/**
 * Unique left-prefix of a longer configured expansion (n > query length).
 * Same bounds as analyze `matchExpansionPrefixes`: ≥2 tokens, coverage ≥ 2/3,
 * unique best coverage. Distinct keys at that coverage fail closed (`none`),
 * so already-attached acronym concepts are not dropped.
 */
function uniqueExpansionLeftPrefix(
  tokens: QueryToken[],
  dict: SearchPlugin
): ConfiguredSequenceResolution {
  const k = tokens.length;
  if (k < MIN_EXPANSION_PREFIX_TOKENS || !dict.sequences?.length) return { status: "none" };
  const candidates: Array<{ seq: DictionarySequence; coverage: number; n: number; usedPrefix: boolean }> =
    [];
  const seen = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.entry?.key || !seq.tokens?.length) continue;
    const n = seq.tokens.length;
    if (n <= k) continue;
    if (seen.has(seq.entry.key)) continue;
    let usedPrefix = k < n;
    let ok = true;
    for (let j = 0; j < k; j++) {
      const want = seq.tokens[j];
      const tok = tokens[j];
      const isLast = j === k - 1;
      if (isLast) {
        if (alignsExact(tok, want)) continue;
        if (!alignsLast(tok, want)) {
          ok = false;
          break;
        }
        usedPrefix = true;
        continue;
      }
      if (!alignsExact(tok, want)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const coverage = k / n;
    if (coverage < MIN_EXPANSION_PREFIX_COVERAGE) continue;
    seen.add(seq.entry.key);
    candidates.push({ seq, coverage, n, usedPrefix });
  }
  if (!candidates.length) return { status: "none" };
  candidates.sort((a, b) => b.coverage - a.coverage || a.n - b.n);
  const best = candidates[0].coverage;
  const top = candidates.filter((c) => c.coverage === best);
  const keys = new Set(top.map((c) => c.seq.entry.key));
  if (keys.size !== 1) return { status: "none" };
  const hit = top[0];
  const entry = dict.byKey?.get(hit.seq.entry.key) || hit.seq.entry;
  return uniqueResolution(entry, ["expansion"], hit.usedPrefix);
}

function configuredKeyPrefixKeys(tok: QueryToken, dict: SearchPlugin): string[] {
  const form = String(tok.normalized || "").toLowerCase();
  if (!form || form.length < 3 || !dict.sequences?.length) return [];
  const keys = new Set<string>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "key" || seq.tokens?.length !== 1 || !seq.entry?.key) continue;
    const want = seq.tokens[0];
    if (!want || want === form) continue;
    if (want.startsWith(form)) keys.add(seq.entry.key);
  }
  return [...keys];
}

function tokenProperPrefixOf(tok: QueryToken, want: string): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (!typed || typed.length >= want.length) return false;
  return allowPrefixMatch(typed, want);
}

/**
 * One-token proper prefix of a configured expansion's first word.
 * Unique key prefixes occupy through the existing key-prefix path instead.
 * Several keys: occupy the unique longest expansion; same-length ties fail closed.
 * Insertion order and lexicographic key order are not used.
 */
function uniqueLongestFirstExpansionPrefix(
  tok: QueryToken,
  dict: SearchPlugin
): { entry: DictionaryEntry } | null {
  if (!tok || !dict.sequences?.length) return null;
  if (configuredKeyPrefixKeys(tok, dict).length) return null;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  if (typed) {
    for (const seq of dict.sequences) {
      if (seq.kind !== "expansion" || !seq.tokens?.length) continue;
      if (seq.tokens[0] === typed) return null;
    }
  }
  const byKey = new Map<string, { entry: DictionaryEntry; expansionLen: number }>();
  for (const seq of dict.sequences) {
    if (seq.kind !== "expansion" || !seq.entry?.key || !seq.tokens?.length) continue;
    const first = seq.tokens[0];
    if (!first || !tokenProperPrefixOf(tok, first)) continue;
    const expansionLen = Math.max((seq.entry.expansion || []).length, seq.tokens.length);
    const prev = byKey.get(seq.entry.key);
    if (!prev || expansionLen > prev.expansionLen) {
      byKey.set(seq.entry.key, { entry: seq.entry, expansionLen });
    }
  }
  if (!byKey.size) return null;
  const rows = [...byKey.values()];
  if (rows.length === 1) return { entry: rows[0].entry };
  let bestLen = -1;
  const winners: DictionaryEntry[] = [];
  for (const row of byKey.values()) {
    if (row.expansionLen > bestLen) {
      bestLen = row.expansionLen;
      winners.length = 0;
      winners.push(row.entry);
    } else if (row.expansionLen === bestLen) {
      winners.push(row.entry);
    }
  }
  if (winners.length !== 1) return null;
  return { entry: winners[0] };
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
    const aligned = sequenceAligns(tokens, seq, dict);
    if (!aligned.ok) continue;
    matches.push({ seq, usedPrefix: aligned.usedPrefix });
    keys.add(seq.entry.key);
  }
  if (matches.length) {
    if (keys.size > 1) return { status: "ambiguous", keys: [...keys] };
    const key = matches[0].seq.entry.key;
    const entry = dict.byKey?.get(key) || matches[0].seq.entry;
    const matchedKinds = [...new Set(matches.map((m) => String(m.seq.kind || "")))].filter(Boolean);
    const usedPrefix = matches.some((m) => m.usedPrefix);
    return uniqueResolution(entry, matchedKinds, usedPrefix);
  }
  const leftPrefix = uniqueExpansionLeftPrefix(tokens, dict);
  if (leftPrefix.status !== "none") return leftPrefix;
  if (tokens.length === 1) {
    const hit = uniqueLongestFirstExpansionPrefix(tokens[0], dict);
    if (hit) return uniqueResolution(hit.entry, ["expansion"], true);
  }
  return { status: "none" };
}

const SPAN_SEQUENCE_KINDS = new Set(["key", "expansion", "alias"]);

/**
 * Typed identity only for expansion/alias windows. Prefix completion and
 * last-token stubs must not create those spans. Configured keys may also
 * occupy from an exact morphology lemma (`apis` → `api`) without rewriting
 * typed surface. `sequenceAligns` keeps prefix behavior for whole-query callers.
 */
function exactTypedToken(tok: QueryToken, want: string): boolean {
  if (!want || !tok) return false;
  const typed = String(tok.surfaceNormalized || tok.surface || "").toLowerCase();
  return typed === want;
}

function sequenceAlignsExactAt(
  tokens: QueryToken[],
  start: number,
  seq: DictionarySequence,
  dict?: SearchPlugin | null
): boolean {
  const want = seq.tokens || [];
  const n = want.length;
  if (!n || start < 0 || start + n > tokens.length) return false;
  if (seq.kind === "key") {
    return n === 1 && tokenAlignsConfiguredKey(tokens[start], want[0], dict);
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
      if (!sequenceAlignsExactAt(tokens, start, seq, dict)) continue;
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
 * `sequenceAligns` prefix rules as whole-query resolution. n>=2 expansion/alias
 * windows plus unique 1-token first-expansion prefixes (longest expansion
 * wins; same-length ties fail closed). Exact windows stay on
 * `resolveConfiguredSpans`. Same-key forms at the same indexes collapse.
 * Distinct keys at the same indexes are dropped.
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
      const aligned = sequenceAligns(tokens.slice(start, start + n), seq, dict);
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
  for (let start = 0; start < tokens.length; start++) {
    const tok = tokens[start];
    if (!tok || DEFAULT_STOP.has(String(tok.normalized || ""))) continue;
    if (exactWindows.has(windowId(start, start + 1))) continue;
    const end = start + 1;
    let contained = false;
    for (const row of grouped.values()) {
      if (start < row.end && end > row.start) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    const hit = uniqueLongestFirstExpansionPrefix(tok, dict);
    if (!hit?.entry?.key) continue;
    const id = windowId(start, end);
    let row = grouped.get(id);
    if (!row) {
      row = { start, end, kinds: new Set(), keys: new Set() };
      grouped.set(id, row);
    }
    row.keys.add(hit.entry.key);
    row.kinds.add("expansion");
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
