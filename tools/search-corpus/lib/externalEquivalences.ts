import { acronymKey, expansionTokens, hasUnsafeSymbolicSurface, OPTIONAL_INITIAL_WORDS, phraseKey, stableSort } from "./text.js";
import { isInflectionPair } from "./synonyms.js";

export class ExternalEquivalenceError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ExternalEquivalenceError";
    this.details = details;
  }
}

export type ExternalEquivalenceRow = {
  key: string;
  expansion: string[];
  aliases: string[][];
  primary: string | null;
  standaloneRecall: string[];
  topicalRecall: string[][];
  evidenceDocumentIds: string[];
  ambiguous: boolean;
  alternatives: Array<{ expansion: string[]; note?: string }>;
  provenance: string;
};

export type ExpansionRelation = "identical" | "compatible" | "ambiguous" | "conflict";

export type EquivalenceReconciliation = {
  key: string;
  kind: ExpansionRelation;
  eligible: boolean;
  canonicalExpansion?: string[];
  aliases?: string[][];
  expansions: string[][];
  evidenceDocumentIds: string[];
};

export type UnresolvedEquivalence = {
  key: string;
  kind: "ambiguous" | "conflict";
  expansions: string[][];
  evidenceDocumentIds: string[];
  eligible: false;
};

export type NormalizeExternalEquivalencesResult = {
  format: "search-corpus-external-equivalences";
  version: 1;
  entries: ExternalEquivalenceRow[];
  rejected: Array<{ index: number; reason: string }>;
  conflicts: Array<{ key: string; expansions: string[][] }>;
  unresolved: UnresolvedEquivalence[];
  reconciliations: EquivalenceReconciliation[];
};

function asExpansion(raw: unknown): string[] {
  // External rows already chose their phrase; do not strip leading function words
  // ("Not Only SQL" must remain ["not","only","sql"]).
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      const part = String(item ?? "").trim();
      if (!part) continue;
      if (hasUnsafeSymbolicSurface(part)) return [];
      const spoken = expansionTokens(part);
      if (/[+#*]/.test(part)) {
        if (!spoken.length) return [];
        out.push(...spoken);
      } else {
        out.push(part.toLowerCase());
      }
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim()) return expansionTokens(raw);
  return [];
}

function asAliases(raw: unknown): string[][] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ExternalEquivalenceError("aliases must be an array");
  return raw
    .map((alias) => asExpansion(alias))
    .filter((tokens) => tokens.length);
}

function asEvidenceIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ExternalEquivalenceError("evidenceDocumentIds must be an array");
  return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))].sort();
}

function asAlternatives(raw: unknown): Array<{ expansion: string[]; note?: string }> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ExternalEquivalenceError("alternatives must be an array");
  return raw
    .map((alt) => {
      if (!alt || typeof alt !== "object" || Array.isArray(alt)) {
        throw new ExternalEquivalenceError("each alternative must be an object");
      }
      const rec = alt as Record<string, unknown>;
      const expansion = asExpansion(rec.expansion);
      if (!expansion.length) return null;
      const note = rec.note == null || rec.note === "" ? undefined : String(rec.note);
      return note ? { expansion, note } : { expansion };
    })
    .filter((alt): alt is { expansion: string[]; note?: string } => alt != null);
}

function mergeAliases(into: string[][], extra: string[][]): string[][] {
  const seen = new Set(into.map((a) => phraseKey(a)));
  const out = [...into];
  for (const alias of extra) {
    const pk = phraseKey(alias);
    if (!seen.has(pk)) {
      seen.add(pk);
      out.push(alias);
    }
  }
  return stableSort(out, (a) => phraseKey(a));
}

function mergeAlternatives(
  into: Array<{ expansion: string[]; note?: string }>,
  extra: Array<{ expansion: string[]; note?: string }>
): Array<{ expansion: string[]; note?: string }> {
  const seen = new Set(into.map((a) => phraseKey(a.expansion)));
  const out = [...into];
  for (const alt of extra) {
    const pk = phraseKey(alt.expansion);
    if (!seen.has(pk)) {
      seen.add(pk);
      out.push(alt);
    }
  }
  return stableSort(out, (a) => phraseKey(a.expansion));
}

function stemToken(token: string): string {
  const t = String(token || "").toLowerCase();
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function contentTokens(tokens: string[], { stripKey = "" }: { stripKey?: string } = {}): string[] {
  const key = String(stripKey || "").toLowerCase();
  return tokens
    .map((t) => String(t || "").toLowerCase())
    .filter((t) => t && !OPTIONAL_INITIAL_WORDS.has(t))
    .map(stemToken)
    .filter((t) => t && t !== key);
}

function isSubsequence(shorter: string[], longer: string[]): boolean {
  if (!shorter.length || shorter.length > longer.length) return false;
  let i = 0;
  for (const token of longer) {
    if (token === shorter[i]) i += 1;
    if (i === shorter.length) return true;
  }
  return false;
}

/**
 * Fold British/American suffix spelling to a shared form.
 * Suffix rewrite class only — not a word list and not an unbounded prefix match.
 */
function foldOrthography(token: string): string {
  let t = String(token || "").toLowerCase();
  t = t.replace(/isation/g, "ization");
  t = t.replace(/([a-z]{3,})our(s|ed|ing|ly|able|al|ous)?$/g, "$1or$2");
  t = t.replace(/dge?ment$/g, "dgment");
  return t;
}

const ABBREVIATION_TAIL = /(?:ation|ization|isation|ative|ence|ency|ance|ous|ual|ment|ical)$/;

function isAbbreviationPair(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 4 || shorter.length > 8) return false;
  if (!longer.startsWith(shorter)) return false;
  if (longer.length - shorter.length < 4) return false;
  if (isInflectionPair(left, right)) return false;
  const rest = longer.slice(shorter.length);
  return ABBREVIATION_TAIL.test(longer) || ABBREVIATION_TAIL.test(rest);
}

function tokenEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  if (isInflectionPair(left, right)) return true;
  if (foldOrthography(left) === foldOrthography(right)) return true;
  if (isAbbreviationPair(left, right)) return true;
  return false;
}

function alignedMorphology(left: string[], right: string[]): boolean {
  if (left.length !== right.length || !left.length) return false;
  return left.every((token, i) => tokenEquivalent(token, right[i]));
}

function commonPrefixLength(left: string[], right: string[]): number {
  const n = Math.min(left.length, right.length);
  let i = 0;
  while (i < n && left[i] === right[i]) i += 1;
  return i;
}

function tokenSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function sharedBigram(left: string[], right: string[]): boolean {
  if (left.length < 2 || right.length < 2) return false;
  const rightGrams = new Set<string>();
  for (let i = 0; i < right.length - 1; i += 1) rightGrams.add(`${right[i]} ${right[i + 1]}`);
  for (let i = 0; i < left.length - 1; i += 1) {
    if (rightGrams.has(`${left[i]} ${left[i + 1]}`)) return true;
  }
  return false;
}

/**
 * Deterministic relation between two expansions of the same generated key.
 * Does not call a model and does not use a synonym table.
 * Compatible covers function-word/plural/inflection variants, British/American
 * suffix spelling, and conservative short-form abbreviations of a longer token
 * (tech/technical). Distinct last-token alternatives stay ambiguous; unrelated
 * meanings stay conflicts.
 */
export function classifyExpansionRelation(
  key: unknown,
  left: unknown,
  right: unknown
): ExpansionRelation {
  const k = acronymKey(key);
  const a = asExpansion(left);
  const b = asExpansion(right);
  if (!a.length || !b.length) return "conflict";
  if (phraseKey(a) === phraseKey(b)) return "identical";

  const aCompat = contentTokens(a, { stripKey: k });
  const bCompat = contentTokens(b, { stripKey: k });
  if (aCompat.length && bCompat.length) {
    if (phraseKey(aCompat) === phraseKey(bCompat)) return "compatible";
    if (phraseKey(aCompat.map(foldOrthography)) === phraseKey(bCompat.map(foldOrthography))) {
      return "compatible";
    }
    if (alignedMorphology(aCompat, bCompat)) return "compatible";
    const shorter = aCompat.length <= bCompat.length ? aCompat : bCompat;
    const longer = aCompat.length <= bCompat.length ? bCompat : aCompat;
    if (shorter.length >= 2 && isSubsequence(shorter, longer)) return "compatible";
  }

  const aRel = contentTokens(a);
  const bRel = contentTokens(b);
  const prefix = commonPrefixLength(aRel, bRel);
  const lastTokenAlternatives =
    prefix >= 1 && aRel.length === prefix + 1 && bRel.length === prefix + 1;
  if (
    lastTokenAlternatives ||
    sharedBigram(aRel, bRel) ||
    jaccard(tokenSet(aRel), tokenSet(bRel)) >= 0.5
  ) {
    return "ambiguous";
  }
  return "conflict";
}

function topicalRecallOf(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!Array.isArray(item) || !item.length) continue;
    const form: string[] = [];
    let malformed = false;
    for (const tok of item) {
      const token = String(tok ?? "").toLowerCase().trim();
      if (!token || /\s/.test(token)) {
        malformed = true;
        break;
      }
      form.push(token);
    }
    if (malformed || !form.length) continue;
    const key = form.join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(form);
  }
  return out;
}

function mergeTopicalRecall(into: string[][], extra: string[][]): string[][] {
  return topicalRecallOf([...into, ...extra]);
}

function cloneRow(row: ExternalEquivalenceRow): ExternalEquivalenceRow {
  return {
    ...row,
    expansion: [...row.expansion],
    aliases: row.aliases.map((a) => [...a]),
    standaloneRecall: [...(row.standaloneRecall || [])],
    topicalRecall: (row.topicalRecall || []).map((form) => [...form]),
    evidenceDocumentIds: [...row.evidenceDocumentIds],
    alternatives: row.alternatives.map((alt) => ({
      expansion: [...alt.expansion],
      ...(alt.note ? { note: alt.note } : {}),
    })),
  };
}

function mergeRows(into: ExternalEquivalenceRow, extra: ExternalEquivalenceRow): void {
  into.evidenceDocumentIds = [...new Set([...into.evidenceDocumentIds, ...extra.evidenceDocumentIds])].sort();
  into.aliases = mergeAliases(into.aliases, extra.aliases);
  into.alternatives = mergeAlternatives(into.alternatives, extra.alternatives);
  if (into.primary == null && extra.primary) into.primary = extra.primary;
  else if (into.primary && extra.primary && into.primary !== extra.primary) into.primary = null;
  into.standaloneRecall = [...new Set([...(into.standaloneRecall || []), ...(extra.standaloneRecall || [])])];
  into.topicalRecall = mergeTopicalRecall(into.topicalRecall || [], extra.topicalRecall || []);
  into.ambiguous = into.ambiguous || extra.ambiguous;
}

function pickCanonical(rows: ExternalEquivalenceRow[]): ExternalEquivalenceRow {
  return stableSort(rows, (row) => {
    const hasKey = row.expansion.map((t) => t.toLowerCase()).includes(row.key) ? "1" : "0";
    const len = String(row.expansion.length).padStart(3, "0");
    return `${hasKey}:${len}:${phraseKey(row.expansion)}`;
  })[0];
}

function clusterCompatible(key: string, rows: ExternalEquivalenceRow[]): ExternalEquivalenceRow[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const relation = classifyExpansionRelation(key, rows[i].expansion, rows[j].expansion);
      if (relation === "identical" || relation === "compatible") union(i, j);
    }
  }
  const groups = new Map<number, ExternalEquivalenceRow[]>();
  rows.forEach((row, i) => {
    const root = find(i);
    const list = groups.get(root) || [];
    list.push(row);
    groups.set(root, list);
  });
  return [...groups.values()].map((group) => stableSort(group, (row) => phraseKey(row.expansion)));
}

function crossClusterKind(key: string, clusters: ExternalEquivalenceRow[][]): "ambiguous" | "conflict" {
  let sawAmbiguous = false;
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      for (const left of clusters[i]) {
        for (const right of clusters[j]) {
          const relation = classifyExpansionRelation(key, left.expansion, right.expansion);
          if (relation === "ambiguous") sawAmbiguous = true;
        }
      }
    }
  }
  return sawAmbiguous ? "ambiguous" : "conflict";
}

function expansionsOf(rows: ExternalEquivalenceRow[]): string[][] {
  return stableSort(
    rows.map((row) => [...row.expansion]),
    (tokens) => phraseKey(tokens)
  );
}

function evidenceOf(rows: ExternalEquivalenceRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.evidenceDocumentIds))].sort();
}

function emptyResult(): NormalizeExternalEquivalencesResult {
  return {
    format: "search-corpus-external-equivalences",
    version: 1,
    entries: [],
    rejected: [],
    conflicts: [],
    unresolved: [],
    reconciliations: [],
  };
}

/**
 * Validate and normalize externally supplied acronym/equivalence rows.
 * Does not call a model. Applications generate rows; this consumer
 * normalizes keys/expansions, rejects empties, collapses identical and
 * trivially compatible duplicates, and records material ambiguity or
 * genuine conflict as unresolved inspection evidence instead of deleting
 * the key.
 */
export function normalizeExternalEquivalences(
  rows: unknown,
  { strict = true }: { strict?: boolean } = {}
): NormalizeExternalEquivalencesResult {
  if (rows == null) return emptyResult();
  if (!Array.isArray(rows)) {
    throw new ExternalEquivalenceError("external equivalences must be an array");
  }

  const rejected: Array<{ index: number; reason: string }> = [];
  const parsed: ExternalEquivalenceRow[] = [];

  rows.forEach((row, index) => {
    try {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new ExternalEquivalenceError("row must be an object");
      }
      const rec = row as Record<string, unknown>;
      const key = acronymKey(rec.key);
      if (!key) throw new ExternalEquivalenceError("empty key");
      const aliasesIn = asAliases(rec.aliases);
      const expansionFromField = asExpansion(rec.expansion);
      const expansion = expansionFromField.length ? expansionFromField : aliasesIn[0] ? [...aliasesIn[0]] : [];
      if (!expansion.length) {
        const raw = rec.expansion ?? rec.aliases;
        const hadRaw =
          (typeof rec.expansion === "string" && String(rec.expansion).trim()) ||
          (Array.isArray(rec.expansion) && rec.expansion.some((item) => String(item || "").trim())) ||
          (Array.isArray(rec.aliases) && rec.aliases.length);
        if (!hadRaw) throw new ExternalEquivalenceError("empty expansion");
        if (hasUnsafeSymbolicSurface(raw) || (Array.isArray(raw) && raw.some((item) => hasUnsafeSymbolicSurface(item)))) {
          throw new ExternalEquivalenceError("unsafe symbolic expansion");
        }
        if (!expansionFromField.length && Array.isArray(rec.aliases)) {
          throw new ExternalEquivalenceError("empty expansion");
        }
        return;
      }
      const aliases = expansionFromField.length
        ? aliasesIn
        : aliasesIn.slice(1);
      const primary =
        rec.primary == null || rec.primary === "" ? null : String(rec.primary).toLowerCase().trim() || null;
      const standaloneRecall = Array.isArray(rec.standaloneRecall)
        ? [...new Set(
            rec.standaloneRecall
              .map((token) => String(token || "").toLowerCase().trim())
              .filter((token) => token && !/\s/.test(token))
          )]
        : [];
      const topicalRecall = topicalRecallOf(rec.topicalRecall);
      const evidenceDocumentIds = asEvidenceIds(rec.evidenceDocumentIds);
      if (rec.ambiguous != null && typeof rec.ambiguous !== "boolean") {
        throw new ExternalEquivalenceError("ambiguous must be boolean");
      }
      parsed.push({
        key,
        expansion,
        aliases,
        primary,
        standaloneRecall,
        topicalRecall,
        evidenceDocumentIds,
        ambiguous: rec.ambiguous === true,
        alternatives: asAlternatives(rec.alternatives),
        provenance: rec.provenance == null || rec.provenance === "" ? "external" : String(rec.provenance),
      });
    } catch (err) {
      rejected.push({ index, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  if (strict && rejected.length) {
    throw new ExternalEquivalenceError(
      "malformed external equivalence rows",
      rejected.map((r) => `[${r.index}] ${r.reason}`)
    );
  }

  const byKey = new Map<string, ExternalEquivalenceRow[]>();
  for (const row of parsed) {
    const list = byKey.get(row.key) || [];
    list.push(row);
    byKey.set(row.key, list);
  }

  const entries: ExternalEquivalenceRow[] = [];
  const conflicts: Array<{ key: string; expansions: string[][] }> = [];
  const unresolved: UnresolvedEquivalence[] = [];
  const reconciliations: EquivalenceReconciliation[] = [];

  for (const key of [...byKey.keys()].sort()) {
    const group = byKey.get(key) || [];
    const byPhrase = new Map<string, ExternalEquivalenceRow>();
    for (const row of group) {
      const pk = phraseKey(row.expansion);
      const existing = byPhrase.get(pk);
      if (existing) mergeRows(existing, row);
      else byPhrase.set(pk, cloneRow(row));
    }
    const unique = stableSort([...byPhrase.values()], (row) => phraseKey(row.expansion));
    const clusters = clusterCompatible(key, unique);
    const allExpansions = expansionsOf(unique);
    const allEvidence = evidenceOf(unique);

    if (clusters.length === 1) {
      const cluster = clusters[0];
      const chosen = pickCanonical(cluster);
      const canonical = cloneRow(chosen);
      for (const row of cluster) {
        if (row === chosen) continue;
        mergeRows(canonical, row);
        if (phraseKey(row.expansion) !== phraseKey(canonical.expansion)) {
          canonical.aliases = mergeAliases(canonical.aliases, [row.expansion]);
        }
      }
      canonical.aliases = canonical.aliases.filter((alias) => phraseKey(alias) !== phraseKey(canonical.expansion));
      canonical.aliases = stableSort(canonical.aliases, (a) => phraseKey(a));
      canonical.alternatives = stableSort(canonical.alternatives, (a) => phraseKey(a.expansion));
      const kind: ExpansionRelation = unique.length === 1 ? "identical" : "compatible";
      const eligible = canonical.ambiguous !== true;
      reconciliations.push({
        key,
        kind,
        eligible,
        canonicalExpansion: [...canonical.expansion],
        aliases: canonical.aliases.map((a) => [...a]),
        expansions: allExpansions,
        evidenceDocumentIds: allEvidence,
      });
      if (!eligible) {
        unresolved.push({
          key,
          kind: "ambiguous",
          expansions: allExpansions,
          evidenceDocumentIds: allEvidence,
          eligible: false,
        });
        continue;
      }
      canonical.ambiguous = false;
      entries.push(canonical);
      continue;
    }

    const kind = crossClusterKind(key, clusters);
    conflicts.push({ key, expansions: allExpansions });
    unresolved.push({
      key,
      kind,
      expansions: allExpansions,
      evidenceDocumentIds: allEvidence,
      eligible: false,
    });
    reconciliations.push({
      key,
      kind,
      eligible: false,
      expansions: allExpansions,
      evidenceDocumentIds: allEvidence,
    });
  }

  return {
    format: "search-corpus-external-equivalences",
    version: 1,
    entries: stableSort(entries, (e) => e.key),
    rejected,
    conflicts,
    unresolved: stableSort(unresolved, (u) => u.key),
    reconciliations: stableSort(reconciliations, (r) => r.key),
  };
}
