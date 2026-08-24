import { allowPrefixMatch } from "./text.js";
import type {
  DictionaryEntry,
  DictionarySequence,
  QueryToken,
  SearchPlugin,
} from "./types.js";

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
