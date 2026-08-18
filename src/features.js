import { isNearCompletePrefix, levenshtein, DEFAULT_STOP, allowPrefixMatch } from "./text.js";
import { isAllDigitToken } from "./versionForms.js";
import { versionHit, conceptMatchesTitle } from "./retrieve.js";

/** @param {import("./types.js").AnalyzedQuery} query */
function queryNonStop(query) {
  const toks = query.tokens.filter((t) => !DEFAULT_STOP.has(t.normalized) || query.tokens.length <= 2);
  return toks.length ? toks : query.tokens;
}

/** @param {import("./types.js").QueryConcept} concept @param {import("./types.js").IndexedDocument} doc */
function conceptCoveredInTitle(concept, doc) {
  return conceptMatchesTitle(concept, doc) != null;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function exactTitle(query, doc) {
  const q = query.tokens.map((t) => t.normalized).join(" ");
  return q.length > 0 && q === doc.normalizedTitle;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function exactTitleTokenMatch(query, doc) {
  return query.tokens.some(
    (t) => !DEFAULT_STOP.has(t.normalized) && doc.titleTokenSet.has(t.normalized)
  );
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function titlePrefixQuality(query, doc) {
  const qToks = queryNonStop(query);
  if (!qToks.length || !doc.titleTokens.length) return 0;
  let matched = 0;
  let prefixChars = 0;
  let titleChars = 0;
  for (const qt of qToks) {
    titleChars += qt.normalized.length;
    const hit = doc.titleTokens.find((tok) => allowPrefixMatch(qt.normalized, tok) || isNearCompletePrefix(qt.normalized, tok));
    if (hit) {
      matched += 1;
      prefixChars += qt.normalized.length;
    }
  }
  if (!matched) return 0;
  const coverage = matched / qToks.length;
  const completeness = titleChars ? prefixChars / Math.max(titleChars, 1) : 0;
  const tightness = qToks.length / Math.max(doc.nonStopTitle.length, 1);
  return Number((0.5 * coverage + 0.3 * completeness + 0.2 * Math.min(1, tightness)).toFixed(4));
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function queryCoverage(query, doc) {
  const concepts = query.concepts.filter((c) => c.kind !== "number" || query.concepts.length === 1);
  const usable = concepts.length ? concepts : query.concepts;
  if (!usable.length) return 0;
  let hit = 0;
  for (const c of usable) {
    if (conceptCoveredInTitle(c, doc) || versionHit(query, doc)) hit += 1;
    else if (c.kind === "number" && versionHit(query, doc)) hit += 1;
  }
  // Count number concepts via version hit once
  const hasNumber = query.concepts.some((c) => c.kind === "number");
  const v = versionHit(query, doc);
  if (hasNumber && v) {
    const withoutNum = query.concepts.filter((c) => c.kind !== "number");
    const numOk = v.compactHit || v.dottedHit;
    const otherHits = withoutNum.filter((c) => conceptCoveredInTitle(c, doc)).length;
    const denom = withoutNum.length + 1;
    return Number(((otherHits + (numOk ? 1 : 0)) / denom).toFixed(4));
  }
  return Number((hit / usable.length).toFixed(4));
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function titleCoverage(query, doc) {
  if (!doc.nonStopTitle.length) return 0;
  let hit = 0;
  for (const tok of doc.nonStopTitle) {
    const ok = query.tokens.some((qt) => {
      if (qt.normalized === tok || qt.lemma === tok) return true;
      if (allowPrefixMatch(qt.normalized, tok) || isNearCompletePrefix(qt.normalized, tok)) return true;
      return query.concepts.some((c) => c.forms.includes(tok) && c.kind !== "acronym");
    });
    if (ok) hit += 1;
  }
  return Number((hit / doc.nonStopTitle.length).toFixed(4));
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function configuredEquivalenceMatch(query, doc) {
  const acr = query.concepts.find((c) => c.kind === "acronym");
  if (!acr) return false;
  if (doc.titleTokenSet.has(acr.id) || doc.titleLemmaSet.has(acr.id)) return "key-in-title";
  const expansion = acr.forms.filter((f) => f !== acr.id);
  const expansionHits = expansion.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
  if (expansion.length >= 2 && expansionHits.length >= 2 && expansionHits.length / expansion.length >= 0.5) {
    return "expansion";
  }
  if (expansion.length < 2 && expansionHits.length) return "expansion";
  if (conceptMatchesTitle(acr, doc)) return "related";
  return false;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function morphologyMatch(query, doc) {
  return query.tokens.some(
    (t) =>
      t.lemma &&
      t.lemma !== t.normalized &&
      (doc.titleLemmaSet.has(t.lemma) || doc.titleTokenSet.has(t.lemma))
  );
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function typoDistance(query, doc) {
  let best = 0;
  for (const t of query.tokens) {
    if (t.normalized.length < 5) continue;
    if (t.sources.includes("repeat-collapse") && doc.titleTokenSet.has(t.normalized)) {
      best = Math.max(best, 1);
      continue;
    }
    for (const tok of doc.titleTokens) {
      if (Math.abs(tok.length - t.normalized.length) > 2) continue;
      const d = levenshtein(t.normalized, tok);
      if (d > 0 && d <= 2) best = Math.max(best, 3 - d);
    }
  }
  return best;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function versionMatch(query, doc) {
  const v = versionHit(query, doc);
  if (!v) return false;
  if (v.dottedHit && (v.companion === "covered" || v.companion === "absent")) return "dotted";
  if (v.compactHit && v.companion === "covered") return "compact-dotted";
  if (v.compactHit && v.companion === "absent") return "compact-weak";
  if (v.compactHit && v.companion === "weak") return "compact-weak";
  if (v.dottedHit) return "dotted-weak";
  return false;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function shortLiteralLeadMatch(query, doc) {
  const q = query.tokens.map((t) => t.normalized).join("");
  if (query.tokens.length !== 1) return false;
  const tok = query.tokens[0].normalized;
  if (tok.length > 3) return false;
  if (!doc.firstToken) return false;
  return doc.firstToken === tok || doc.firstToken.startsWith(tok);
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function phraseAdjacency(query, doc) {
  const qToks = queryNonStop(query).map((t) => t.normalized);
  if (qToks.length < 2) return 0;
  const title = doc.titleTokens;
  for (let i = 0; i <= title.length - qToks.length; i++) {
    let ok = true;
    for (let j = 0; j < qToks.length; j++) {
      const qt = qToks[j];
      const tt = title[i + j];
      const digitSafe = /^\d+$/.test(qt) || /^\d+$/.test(tt) ? tt === qt : tt === qt || tt.startsWith(qt);
      if (!digitSafe) {
        ok = false;
        break;
      }
    }
    if (ok) return 1;
  }
  const body = doc.bodyTokens;
  for (let i = 0; i <= body.length - qToks.length; i++) {
    let ok = true;
    for (let j = 0; j < qToks.length; j++) {
      if (body[i + j] !== qToks[j] && !body[i + j]?.startsWith(qToks[j])) {
        ok = false;
        break;
      }
    }
    if (ok) return 0.5;
  }
  return 0;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function expansionEvidence(query, doc) {
  const acr = query.concepts.find((c) => c.kind === "acronym");
  if (!acr) return 0;
  const expansion = acr.forms.filter((f) => f !== acr.id && !/^\d+$/.test(f));
  if (!expansion.length) return 0;
  const hits = expansion.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
  return Number((hits.length / expansion.length).toFixed(4));
}

/** @param {import("./types.js").AnalyzedQuery} query */
function queryIsConfiguredKey(query) {
  const acr = query.concepts.find((c) => c.kind === "acronym");
  if (!acr) return false;
  if (query.tokens.length !== 1) return false;
  return query.tokens[0].normalized === acr.id;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function canonicalKeyTitle(query, doc) {
  if (!queryIsConfiguredKey(query)) return false;
  const acr = query.concepts.find((c) => c.kind === "acronym");
  if (!acr) return false;
  const keyInTitle = doc.titleTokenSet.has(acr.id) || doc.titleLemmaSet.has(acr.id);
  if (!keyInTitle) return false;
  return expansionEvidence(query, doc) >= 0.5;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc @param {Partial<import("./types.js").FeatureVector>} f */
function hasDirectTitleEvidence(query, doc, f) {
  if (f.exactTitleMatch || f.exactTitleTokenMatch) return true;
  if ((f.queryCoverage || 0) > 0) return true;
  if (f.configuredEquivalenceMatch) return true;
  if (f.morphologyMatch) return true;
  if (f.versionMatch) return true;
  if ((f.titlePrefixQuality || 0) > 0) return true;
  if (f.canonicalKeyTitle) return true;
  return false;
}

/** @param {import("./types.js").AnalyzedQuery} query @param {import("./types.js").IndexedDocument} doc */
function bodyLexicalMatch(query, doc) {
  let hits = 0;
  for (const c of query.concepts) {
    const inBody = c.forms.some((f) => doc.bodyTokenSet.has(f) || doc.bodyLemmaSet.has(f));
    if (inBody) hits += 1;
  }
  if (!query.concepts.length) return 0;
  return Number((hits / query.concepts.length).toFixed(4));
}

/**
 * @param {import("./types.js").AnalyzedQuery} query
 * @param {import("./types.js").IndexedDocument} doc
 * @param {{ relationship?: import("./types.js").RelationshipInfo | null, retrievalScore?: number }} [opts]
 * @returns {import("./types.js").FeatureVector}
 */
export function extractFeatures(query, doc, { relationship = null, retrievalScore = 0 } = {}) {
  /** @type {import("./types.js").FeatureVector} */
  const base = {
    exactTitleMatch: exactTitle(query, doc),
    exactTitleTokenMatch: exactTitleTokenMatch(query, doc),
    titleCoverage: titleCoverage(query, doc),
    queryCoverage: queryCoverage(query, doc),
    titlePrefixQuality: titlePrefixQuality(query, doc),
    configuredEquivalenceMatch: configuredEquivalenceMatch(query, doc),
    morphologyMatch: morphologyMatch(query, doc),
    typoDistance: typoDistance(query, doc),
    versionMatch: versionMatch(query, doc),
    shortLiteralLeadMatch: shortLiteralLeadMatch(query, doc),
    phraseAdjacency: phraseAdjacency(query, doc),
    bodyLexicalMatch: bodyLexicalMatch(query, doc),
    titleTokenCount: doc.nonStopTitle.length,
    expansionEvidence: expansionEvidence(query, doc),
    canonicalKeyTitle: canonicalKeyTitle(query, doc),
    relationshipStrength: relationship?.strength || 0,
    relationshipType: relationship?.type ?? null,
    relationshipSourceId: relationship?.sourceId ?? null,
    retrievalScore: retrievalScore || 0,
    relevanceKind: "direct",
    directClass: "none",
  };
  const direct = hasDirectTitleEvidence(query, doc, base);
  base.directClass = classifyDirect(base);
  base.relevanceKind = relationship && !direct ? "related" : "direct";
  if (base.relevanceKind === "related" && base.directClass === "none") {
    base.directClass = "none";
  }
  return base;
}

/**
 * Interpretable direct-evidence class from named features. Not a float score.
 *   strong   — exact title, configured key-in-title, canonical expansion title, full coverage, dotted version
 *   moderate — meaningful title match / high query coverage / expansion / phrase
 *   weak     — incidental title token or body-only overlap
 *   none     — no lexical evidence (typical of a pure related neighbor)
 */
/** @param {Partial<import("./types.js").FeatureVector>} f @returns {import("./types.js").DirectClass} */
export function classifyDirect(f) {
  if (
    f.exactTitleMatch ||
    f.configuredEquivalenceMatch === "key-in-title" ||
    f.canonicalKeyTitle ||
    ((f.queryCoverage || 0) >= 0.999 && (f.titlePrefixQuality || 0) >= 0.4) ||
    f.versionMatch === "compact-dotted" ||
    f.versionMatch === "dotted"
  ) {
    return "strong";
  }
  if (
    (f.queryCoverage || 0) >= 0.67 ||
    (f.titlePrefixQuality || 0) >= 0.5 ||
    f.configuredEquivalenceMatch === "expansion" ||
    f.phraseAdjacency === 1 ||
    f.shortLiteralLeadMatch ||
    (f.exactTitleTokenMatch && (f.queryCoverage || 0) > 0)
  ) {
    return "moderate";
  }
  if (
    f.exactTitleTokenMatch ||
    f.morphologyMatch ||
    (f.typoDistance || 0) > 0 ||
    (f.bodyLexicalMatch || 0) > 0 ||
    (f.queryCoverage || 0) > 0 ||
    (f.titlePrefixQuality || 0) > 0 ||
    f.configuredEquivalenceMatch
  ) {
    return "weak";
  }
  return "none";
}

export const FEATURE_DEFINITIONS = {
  exactTitleMatch: "True when normalized query equals the full normalized title.",
  exactTitleTokenMatch: "True when a non-stop query surface token occurs as a title token (not merely a lemma).",
  titleCoverage: "Fraction of non-stop title tokens accounted for by the query.",
  queryCoverage: "Fraction of query concepts evidenced in the title (or via a legitimate version alias).",
  titlePrefixQuality: "How completely query tokens prefix title tokens, tightened by extra title tokens.",
  configuredEquivalenceMatch: "Dictionary hit: key-in-title | expansion | related | false.",
  morphologyMatch: "Query lemma matches a title token/lemma while surface may differ.",
  typoDistance: "0–2 style evidence: 0 none, 1 repeat-collapse or edit-distance 2, 2 edit-distance 1.",
  versionMatch: "false | compact-weak | compact-dotted | dotted | dotted-weak.",
  shortLiteralLeadMatch: "Short query (≤3) matches the first surface title token as exact or prefix.",
  phraseAdjacency: "1 title-adjacent query tokens, 0.5 body-adjacent, else 0.",
  bodyLexicalMatch: "Fraction of query concepts evidenced in the body field.",
  titleTokenCount: "Non-stop title token count; used for tightness, not as a boost constant.",
  expansionEvidence: "Fraction of a configured expansion evidenced in the title.",
  canonicalKeyTitle: "True when the query is exactly a configured key and the title also states most of the expansion.",
  relationshipStrength: "0–1 strength of a precomputed document relationship used for related-result ranking. 0 if none.",
  relationshipType: "Relationship type (semantic, same-category, …) or null. Not a query equivalence.",
  relationshipSourceId: "Primary document id that licensed this related candidate, or null.",
  retrievalScore: "Optional 0–1 retrieval evidence (e.g. normalized BM25). Default 0; not a substitute for constraints.",
  relevanceKind: "direct | related. Related never counts as direct-intent evidence.",
  directClass: "strong | moderate | weak | none. Interpretable lexical evidence class, independent of relatedness.",
};
