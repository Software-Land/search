import { tokenize, isProtectedLiteral, FUNCTION_WORDS, stableSort } from "./text.js";
import type { CorpusDocument, VocabularyArtifact, VocabularyTerm } from "../types.js";

const JUNK = /^(https?|www|html|href|class|span|div|src)$/;
const CODEISH = /[0-9]{4,}|[a-z]+[A-Z]|[_$]{2}/;

export function buildVocabulary(
  documents: CorpusDocument[],
  { acceptedEquivalences = [] }: { acceptedEquivalences?: Array<{ key?: string; expansion?: string[]; aliases?: unknown[] }> } = {}
): VocabularyArtifact {
  const byTerm = new Map<string, { term: string; tf: number; df: number; titleDf: number; docs: Set<unknown>; surfaces: Set<string> }>();

  function add(term: unknown, { title = false, docId }: { title?: boolean; docId: unknown }) {
    const t = String(term || "").toLowerCase();
    if (!t || t.length > 32) return;
    if (JUNK.test(t)) return;
    let row = byTerm.get(t);
    if (!row) {
      row = { term: t, tf: 0, df: 0, titleDf: 0, docs: new Set(), surfaces: new Set([t]) };
      byTerm.set(t, row);
    }
    row.tf += 1;
    row.docs.add(docId);
    if (title) row.titleDf += 1;
  }

  for (const doc of documents) {
    const titleToks = tokenize(doc.title);
    const bodyToks = tokenize(doc.body);
    const seenTitle = new Set<string>();
    for (const tok of titleToks) {
      add(tok, { title: !seenTitle.has(tok), docId: doc.id });
      seenTitle.add(tok);
    }
    const seenBody = new Set<string>();
    for (const tok of bodyToks) {
      if (seenBody.has(tok)) {
        add(tok, { title: false, docId: doc.id });
        continue;
      }
      seenBody.add(tok);
      add(tok, { title: false, docId: doc.id });
    }
  }

  const configured = new Set<string>();
  for (const e of acceptedEquivalences) {
    if (e.key) configured.add(e.key);
    for (const w of e.expansion || []) configured.add(w);
    for (const alias of e.aliases || []) {
      const words = Array.isArray(alias) ? alias : [alias];
      for (const w of words) configured.add(String(w));
    }
  }

  const terms: VocabularyTerm[] = [];
  for (const row of byTerm.values()) {
    row.df = row.docs.size;
    const literal = isProtectedLiteral(row.term);
    const domain =
      literal ||
      configured.has(row.term) ||
      row.titleDf >= 1 ||
      (row.df >= 2 && row.term.length >= 4 && !FUNCTION_WORDS.has(row.term));
    const spellingTrusted =
      literal ||
      configured.has(row.term) ||
      row.titleDf >= 1 ||
      (row.df >= 2 && row.term.length >= 5 && !FUNCTION_WORDS.has(row.term) && !CODEISH.test(row.term));
    if (!domain && !spellingTrusted && row.df < 2) continue;
    terms.push({
      term: row.term,
      tf: row.tf,
      df: row.df,
      titleDf: row.titleDf,
      kind: literal ? "literal" : configured.has(row.term) ? "concept" : row.titleDf ? "title" : domain ? "domain" : "general",
      spellingTrusted,
      surfaces: [...row.surfaces].sort(),
    });
  }

  return {
    format: "search-v2-vocabulary",
    version: 1,
    terms: stableSort(terms, (t) => t.term),
  };
}

export function spellingTerms(vocabulary: VocabularyArtifact | { terms?: VocabularyTerm[] } | null | undefined): string[] {
  return (vocabulary?.terms || []).filter((t) => t.spellingTrusted).map((t) => t.term);
}

/**
 * Optional runtime plugin. Search Core already honors plugin.lexicon().
 * This module is not imported by Search Core.
 */
export function spellingLexiconPlugin(terms?: unknown) {
  const set = new Set((Array.isArray(terms) ? terms : []).filter((t) => typeof t === "string" && t.length >= 5));
  return {
    name: "corpus-spelling-lexicon",
    lexicon() {
      return set;
    },
  };
}
