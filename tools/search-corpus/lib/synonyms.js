import { tokenize, FUNCTION_WORDS, stableSort } from "./text.js";
import { synonymId } from "./ids.js";

/**
 * Synonym *candidates* only. Nothing is auto-accepted into runtime.
 * Relatedness (TLS/VPN, authn/authz, TCP/UDP) is not synonymy.
 */

export const RELATEDNESS_BLOCKLIST = new Set([
  "tls::vpn",
  "vpn::tls",
  "tls::encryption",
  "authentication::authorization",
  "authorization::authentication",
  "auth::authorization",
  "authorization::auth",
  "authn::authz",
  "iot::io",
  "io::iot",
  "tcp::udp",
  "udp::tcp",
  "container::kubernetes",
  "kubernetes::container",
  "docker::kubernetes",
  "kubernetes::docker",
]);

/** @param {string} a @param {string} b */
function pairKey(a, b) {
  return `${a}::${b}`;
}

/** @param {string} a @param {string} b */
export function isInflectionPair(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const rest = l.startsWith(s) ? l.slice(s.length) : "";
  if (/^(?:s|es|ed|ing|izing|er|ers|ly|ally|d|ling)$/.test(rest)) return true;
  if (l === `${s}s` || l === `${s}es`) return true;
  if (l === `${s}d` && s.endsWith("e")) return true;
  if (s.endsWith("e") && l === `${s.slice(0, -1)}ing`) return true;
  if (s.endsWith("y") && l === `${s.slice(0, -1)}ies`) return true;
  const stem = (/** @type {string} */ t) => t.replace(/(?:ing|ed|es|ers|er|ly)$/u, "").replace(/s$/u, "");
  if (stem(a) === stem(b) && stem(a).length >= 5 && a !== b) return true;
  return false;
}

const ALIAS_TAIL = /(?:ation|ization|isation|ative|ence|ency|ance|ous|ual|ment)$/;

/** @param {string} a @param {string} b */
function isAliasShortForm(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 4 || s.length > 8) return false;
  if (!l.startsWith(s)) return false;
  if (l.length - s.length < 4) return false;
  if (isInflectionPair(a, b)) return false;
  const rest = l.slice(s.length);
  return ALIAS_TAIL.test(l) || ALIAS_TAIL.test(rest);
}

/** @param {string} a @param {string} b */
function blocked(a, b) {
  return RELATEDNESS_BLOCKLIST.has(pairKey(a, b)) || RELATEDNESS_BLOCKLIST.has(pairKey(b, a));
}

const AKA_PAREN =
  /\b([A-Za-z][A-Za-z0-9+#-]{2,24})\s*\(\s*(?:a\.?k\.?a\.?|also called|short for|abbreviated(?:\s+as)?)\s+([A-Za-z][A-Za-z0-9+#\s-]{2,40})\s*\)/gi;

/** @param {import("../types.js").CorpusDocument[]} documents @param {{ df: Map<string, number>, titleDf: Map<string, number>, push: (row: import("../types.js").SynonymCandidate) => void }} opts */
function mineExplicitAliasMentions(documents, { df, titleDf, push }) {
  for (const doc of documents) {
    const text = `${doc.title || ""} ${doc.body || ""}`;
    AKA_PAREN.lastIndex = 0;
    let m;
    while ((m = AKA_PAREN.exec(text))) {
      const left = tokenize(m[1]).filter((t) => !FUNCTION_WORDS.has(t));
      const right = tokenize(m[2]).filter((t) => !FUNCTION_WORDS.has(t));
      if (left.length !== 1 || right.length !== 1) continue;
      const a = left[0];
      const b = right[0];
      if (a === b || a.length < 3 || b.length < 3) continue;
      if (blocked(a, b) || isInflectionPair(a, b)) continue;
      const [s, l] = a.length <= b.length ? [a, b] : [b, a];
      const relation = l.startsWith(s) && s.length >= 4 ? "alias" : "synonym";
      push({
        type: "synonym-candidate",
        id: synonymId([a, b]),
        terms: [a, b].sort(),
        relation,
        status: "review",
        decision: "explicit-alias-pattern",
        morphologyRedundant: false,
        evidence: {
          dfA: df.get(a) || 0,
          dfB: df.get(b) || 0,
          titleDfA: titleDf.get(a) || 0,
          titleDfB: titleDf.get(b) || 0,
          explicitAlias: 1,
        },
        provenance: [{ type: "explicit-alias", documentId: doc.id, snippet: m[0].slice(0, 160) }],
        reasons: ["explicit aka / also-called / short-for pattern"],
      });
    }
  }
}

/** @param {import("../types.js").CorpusDocument[]} documents @param {{ acceptedEquivalences?: Array<{ key?: string, expansion?: string[] }> }} [opts] */
export function mineSynonymCandidates(documents, { acceptedEquivalences = [] } = {}) {
  const df = new Map();
  const titleDf = new Map();
  for (const doc of documents) {
    const titleSeen = new Set(tokenize(doc.title));
    const seen = new Set(tokenize(`${doc.title} ${doc.body}`));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    for (const t of titleSeen) titleDf.set(t, (titleDf.get(t) || 0) + 1);
  }

  const terms = [...df.entries()]
    .filter(([t, n]) => n >= 2 && t.length >= 3 && !FUNCTION_WORDS.has(t))
    .map(([t]) => t)
    .sort();

  /** @type {import("../types.js").SynonymCandidate[]} */
  const out = [];
  const seenIds = new Set();

  /** @param {import("../types.js").SynonymCandidate} row */
  function push(row) {
    if (seenIds.has(row.id)) return;
    seenIds.add(row.id);
    out.push(row);
  }

  mineExplicitAliasMentions(documents, { df, titleDf, push });

  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      const a = terms[i];
      const b = terms[j];
      if (blocked(a, b)) continue;
      if (isInflectionPair(a, b)) continue;

      let relation = null;
      let decision = null;
      if (isAliasShortForm(a, b)) {
        const [s, l] = a.length <= b.length ? [a, b] : [b, a];
        const strong =
          (df.get(s) || 0) >= 3 &&
          (df.get(l) || 0) >= 3 &&
          ((titleDf.get(l) || 0) >= 1 || (titleDf.get(s) || 0) >= 1);
        if (!strong) continue;
        relation = "alias";
        decision = "short-form-prefix";
      } else {
        continue;
      }

      push({
        type: "synonym-candidate",
        id: synonymId([a, b]),
        terms: [a, b].sort(),
        relation,
        status: "review",
        decision,
        morphologyRedundant: false,
        evidence: {
          dfA: df.get(a),
          dfB: df.get(b),
          titleDfA: titleDf.get(a) || 0,
          titleDfB: titleDf.get(b) || 0,
        },
        provenance: [{ type: "corpus-frequency" }],
        reasons: ["short-form / alias prefix", "both appear in ≥2 documents"],
      });
    }
  }

  for (const e of acceptedEquivalences) {
    const key = e.key;
    const word = e.expansion?.[0];
    if (key && word && e.expansion?.length === 1 && word.length >= 6 && word !== key) {
      const termsPair = [key, word];
      if (blocked(termsPair[0], termsPair[1])) continue;
      if (isInflectionPair(termsPair[0], termsPair[1])) continue;
      push({
        type: "synonym-candidate",
        id: synonymId(termsPair),
        terms: [...termsPair].sort(),
        relation: "alias",
        status: "review",
        decision: "accepted-equivalence-alias",
        morphologyRedundant: false,
        evidence: { fromEquivalence: key },
        provenance: [{ type: "accepted-equivalence" }],
        reasons: ["alias of an accepted equivalence"],
      });
    }
  }

  return stableSort(out, (c) => (c.terms || []).join(":"));
}
