/**
 * Frozen extractFeatures / classifyDirect from the pre-optimization 0.4.0
 * engine. Tests treat this module as the feature-vector truth.
 * Transpiled into build/test/oracles/ for tests and benchmarks; excluded from
 * production dist and the npm tarball.
 */

import { isNearCompletePrefix, levenshtein, DEFAULT_STOP, allowPrefixMatch } from "../../src/text.js";
import { hasIndependentTitleToken, isDottedSpanComponentIndex, queryTokenMatchesDottedSpanComponent } from "../../src/versionForms.js";
import { versionHit, conceptMatchesTitle, conceptMatchesBody, matchContextualTitlePrefix, isBoundTrailingTypedToken, isBoundTrailingTermConcept, hasConfiguredSequenceIntent, hasConfiguredContentIdentity, identityTokens, evidenceTokens, isSearchEquivalenceRecallConcept, formContentTokens, sequenceCount, shortTitleTokenPrefixStub, configuredConceptFieldMatch, rankingCoverageConcepts } from "../../src/retrieve.js";
import { querySemanticFacts } from "../../src/querySemantics.js";
import { saturatingFrequency } from "../../src/saturatingFrequency.js";
import { canonicalLexicalTokensFromQuery, extractCanonicalNgrams } from "../../src/lexicalNormalize.js";
import { sequenceKey } from "../../src/configuredAuthoring.js";
import {
  FULL_QUERY_COVERAGE,
  TWO_THIRDS_QUERY_COVERAGE,
  MODERATE_TITLE_PREFIX_QUALITY,
  STRONG_WITH_FULL_COVERAGE_TITLE_PREFIX_QUALITY,
  REPEATED_BODY_PHRASE_MIN,
} from "../../src/evidencePolicy.js";
import type {
  AnalyzedQuery,
  ContextualTitlePrefix,
  DirectClass,
  FeatureVector,
  IndexedDocument,
  QueryConcept,
  QueryToken,
  RelationshipInfo,
} from "../../src/types.js";

export { saturatingFrequency };

function peerFormsOf(concept: QueryConcept | null | undefined): string[][] {
  if (!concept) return [];
  const raw = Array.isArray(concept.aliases) && concept.aliases.length
    ? concept.aliases
    : concept.matchedForm?.length
      ? [concept.matchedForm]
      : [];
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const alias of raw) {
    const seq = (alias || []).filter((f) => f && !/^\d+$/.test(f));
    if (!seq.length) continue;
    const key = sequenceKey(seq);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seq);
  }
  return out.sort((a, b) => sequenceKey(a).localeCompare(sequenceKey(b)));
}

function formContributesQueryShapedTitle(form: string[], doc: IndexedDocument) {
  const content = formContentTokens(form);
  if (!content.length) return false;
  if (form.length === 1) return hasIndependentTitleToken(doc, content[0]);
  if (exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas)) return true;
  const hits = content.filter((t) => hasIndependentTitleToken(doc, t));
  return hits.length >= 2;
}

function peerFormJoinsOf(concept: QueryConcept | null | undefined): string[] {
  const joins = new Set<string>();
  if (concept?.id) joins.add(concept.id);
  for (const form of peerFormsOf(concept)) {
    const join = form.join(" ");
    if (join) joins.add(join);
  }
  return [...joins].sort();
}

function primaryPhraseOf(keys: string[]): string {
  if (!keys.length) return "";
  let best = keys[0];
  let bestN = best.split(/\s+/).length;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const n = key.split(/\s+/).length;
    if (n > bestN || (n === bestN && key < best)) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

type ConfiguredConceptMatch = false | "key-in-title" | "form";
type VersionMatch = false | "dotted" | "compact-dotted" | "compact-weak" | "dotted-weak";

function queryNonStop(query: AnalyzedQuery) {
  const ranking = identityTokens(query);
  const toks = ranking.filter((t) => !DEFAULT_STOP.has(t.normalized) || ranking.length <= 2);
  return toks.length ? toks : ranking;
}

function conceptCoveredInTitle(concept: QueryConcept, doc: IndexedDocument, query: AnalyzedQuery) {
  return conceptMatchesTitle(concept, doc, query) != null;
}

function exactTitle(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = query.concepts.find((c) => c.kind === "configured-concept") || null;
  const joins = peerFormJoinsOf(acr);
  if (hasConfiguredSequenceIntent(query) && joins.length) return joins.includes(doc.normalizedTitle);
  if (
    querySemanticFacts(query).configured.hasRankingIdentity &&
    joins.length &&
    joins.includes(doc.normalizedTitle)
  ) {
    return true;
  }
  const q = identityTokens(query).map((t) => t.normalized).join(" ");
  return q.length > 0 && q === doc.normalizedTitle;
}

function tokenLiteral(t: QueryToken) {
  return t.surfaceNormalized || t.surface;
}

function hasBoundContextualCompletion(query: AnalyzedQuery) {
  return querySemanticFacts(query).completion.boundTrailing;
}

function exactTitleTokenMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    const acr = query.concepts.find((c) => c.kind === "configured-concept");
    for (const form of peerFormsOf(acr)) {
      if (formContributesQueryShapedTitle(form, doc)) return true;
    }
    return false;
  }
  return evidenceTokens(query).some((t) => {
    if (DEFAULT_STOP.has(t.normalized)) return false;
    return hasIndependentTitleToken(doc, t.normalized);
  });
}

/**
 * Typed/repaired surface (pre-lemma, pre-unique-prefix rewrite) agrees with a
 * title token: exact token, or the typed stub prefixes a title token.
 * Canonical lemmas and completedToken are not typed-surface evidence.
 * One-token first-form prefix occupancy unions this typed check with peer-form
 * title evidence.
 */
function typedContentLiterals(query: AnalyzedQuery) {
  const stream = query.tokens || [];
  if (!stream.length) return [];
  const last = stream[stream.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  const out: string[] = [];
  for (const t of stream) {
    if (skipLast && t === last) continue;
    const literal = String(tokenLiteral(t) || "").toLowerCase();
    if (!literal || DEFAULT_STOP.has(literal)) continue;
    out.push(literal);
  }
  return out;
}

function occupancyUnionsTypedTitleEvidence(query: AnalyzedQuery) {
  if (!hasConfiguredSequenceIntent(query)) return false;
  if ((query.tokens || []).length !== 1) return false;
  const key = query.configuredSequenceIntent?.key;
  const acr = query.concepts.find((c) => c.kind === "configured-concept" && c.id === key);
  const coverage = acr?.formCoverage;
  return typeof coverage === "number" && coverage > 0 && coverage < 1;
}

function typedTitleSurfaceHit(query: AnalyzedQuery, doc: IndexedDocument) {
  return typedContentLiterals(query).some((literal) => {
    if (hasIndependentTitleToken(doc, literal)) return true;
    return doc.titleTokens.some(
      (tok, i) =>
        !isDottedSpanComponentIndex(doc, i) &&
        (allowPrefixMatch(literal, tok) || isNearCompletePrefix(literal, tok))
    );
  });
}

function typedSurfaceTitleMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    if (occupancyUnionsTypedTitleEvidence(query) && typedTitleSurfaceHit(query, doc)) return true;
    const acr = query.concepts.find((c) => c.kind === "configured-concept");
    for (const form of peerFormsOf(acr)) {
      if (!formContributesQueryShapedTitle(form, doc)) continue;
      if (
        formContentTokens(form).some((literal) => {
          if (hasIndependentTitleToken(doc, literal)) return true;
          return doc.titleTokens.some(
            (tok, i) =>
              !isDottedSpanComponentIndex(doc, i) &&
              (allowPrefixMatch(literal, tok) || isNearCompletePrefix(literal, tok))
          );
        })
      ) {
        return true;
      }
    }
    return false;
  }
  return typedTitleSurfaceHit(query, doc);
}

function titlePrefixQuality(query: AnalyzedQuery, doc: IndexedDocument) {
  const scoreNorms = (qNorms: string[]) => {
    if (!qNorms.length || !doc.titleTokens.length) return 0;
    let matched = 0;
    let prefixChars = 0;
    let titleChars = 0;
    for (const qn of qNorms) {
      titleChars += qn.length;
      const hit = doc.titleTokens.find(
        (tok, i) =>
          !isDottedSpanComponentIndex(doc, i) &&
          (allowPrefixMatch(qn, tok) || isNearCompletePrefix(qn, tok))
      );
      if (hit) {
        matched += 1;
        prefixChars += qn.length;
      }
    }
    if (!matched) return 0;
    const coverage = matched / qNorms.length;
    const completeness = titleChars ? prefixChars / Math.max(titleChars, 1) : 0;
    const tightness = qNorms.length / Math.max(doc.nonStopTitle.length, 1);
    return Number((0.5 * coverage + 0.3 * completeness + 0.2 * Math.min(1, tightness)).toFixed(4));
  };
  if (hasConfiguredSequenceIntent(query)) {
    const acr = query.concepts.find((c) => c.kind === "configured-concept");
    let best = 0;
    for (const form of peerFormsOf(acr)) {
      if (!formContributesQueryShapedTitle(form, doc)) continue;
      const v = scoreNorms(formContentTokens(form));
      if (v > best) best = v;
    }
    if (occupancyUnionsTypedTitleEvidence(query)) {
      best = Math.max(best, scoreNorms(typedContentLiterals(query)));
    }
    return best;
  }
  const last = query.tokens[query.tokens.length - 1];
  const skipLast = hasBoundContextualCompletion(query);
  const qToks = queryNonStop(query).filter((qt) => !(skipLast && qt === last));
  const literal = scoreNorms(qToks.map((qt) => qt.normalized));
  if (!hasConfiguredContentIdentity(query)) return literal;
  const acr = query.concepts.find((c) => c.kind === "configured-concept") || null;
  let best = literal;
  for (const form of peerFormsOf(acr)) {
    const content = formContentTokens(form);
    if (!content.length) continue;
    const join = form.join(" ");
    const fullTitle = join === doc.normalizedTitle;
    const contiguous =
      form.length >= 2 &&
      (exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas));
    const singletonTitle =
      form.length === 1 &&
      hasIndependentTitleToken(doc, content[0]) &&
      doc.nonStopTitle.length > 0 &&
      doc.nonStopTitle.every((tok) => tok === content[0]);
    if (!fullTitle && !contiguous && !singletonTitle) continue;
    const v = scoreNorms(content);
    if (v > best) best = v;
  }
  return best;
}

function queryCoverage(query: AnalyzedQuery, doc: IndexedDocument) {
  const unboundConcepts = query.concepts.filter((c) => !isBoundTrailingTermConcept(query, c));
  const concepts = unboundConcepts.filter((c) => c.kind !== "number" || unboundConcepts.length === 1);
  const usable = rankingCoverageConcepts(query, concepts.length ? concepts : unboundConcepts);
  if (!usable.length) return 0;
  let hit = 0;
  for (const c of usable) {
    if (conceptCoveredInTitle(c, doc, query) || versionHit(query, doc)) hit += 1;
    else if (c.kind === "number" && versionHit(query, doc)) hit += 1;
  }
  // Count number concepts via version hit once
  const hasNumber = unboundConcepts.some((c) => c.kind === "number");
  const v = versionHit(query, doc);
  if (hasNumber && v) {
    const withoutNum = rankingCoverageConcepts(query, unboundConcepts.filter((c) => c.kind !== "number"));
    const numOk = v.compactHit || v.dottedHit;
    const otherHits = withoutNum.filter((c) => conceptCoveredInTitle(c, doc, query)).length;
    const denom = withoutNum.length + 1;
    return Number(((otherHits + (numOk ? 1 : 0)) / denom).toFixed(4));
  }
  return Number((hit / usable.length).toFixed(4));
}

function titleCoverage(query: AnalyzedQuery, doc: IndexedDocument) {
  if (!doc.nonStopTitle.length) return 0;
  const cover = (qToks: Array<{ normalized: string; lemma?: string }>) => {
    let hit = 0;
    for (let i = 0; i < doc.titleTokens.length; i++) {
      const tok = doc.titleTokens[i];
      if (DEFAULT_STOP.has(tok)) continue;
      const spanComponent = isDottedSpanComponentIndex(doc, i);
      const ok = qToks.some((qt) => {
        if (spanComponent && (qt.normalized === tok || qt.lemma === tok)) return false;
        if (qt.normalized === tok || qt.lemma === tok) return true;
        if (spanComponent) return false;
        if (allowPrefixMatch(qt.normalized, tok) || isNearCompletePrefix(qt.normalized, tok)) return true;
        return query.concepts.some(
          (c) => c.kind !== "configured-concept" && !isBoundTrailingTermConcept(query, c) && c.forms.includes(tok)
        );
      });
      if (ok) hit += 1;
    }
    return Number((hit / doc.nonStopTitle.length).toFixed(4));
  };
  if (hasConfiguredSequenceIntent(query)) {
    const acr = query.concepts.find((c) => c.kind === "configured-concept");
    let best = 0;
    for (const form of peerFormsOf(acr)) {
      if (!formContributesQueryShapedTitle(form, doc)) continue;
      const v = cover(formContentTokens(form).map((t) => ({ normalized: t, lemma: t })));
      if (v > best) best = v;
    }
    return best;
  }
  return cover(evidenceTokens(query));
}

function configuredConceptFieldEvidence(
  query: AnalyzedQuery,
  doc: IndexedDocument
): FeatureVector["configuredConceptFieldEvidence"] {
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return { title: false, summary: false, body: false };
  const summaryTokens = doc.summaryTokens || [];
  const summaryLemmas = doc.summaryLemmas || summaryTokens;
  return {
    title: configuredConceptFieldMatch(
      acr,
      doc.titleTokens,
      doc.titleLemmas,
      doc.titleTokenSet,
      doc.titleLemmaSet,
      { requireContiguous: false }
    ),
    summary: configuredConceptFieldMatch(
      acr,
      summaryTokens,
      summaryLemmas,
      doc.summaryTokenSet || new Set(summaryTokens),
      doc.summaryLemmaSet || new Set(summaryLemmas),
      { requireContiguous: true }
    ),
    body: configuredConceptFieldMatch(
      acr,
      doc.bodyTokens,
      doc.bodyLemmas,
      doc.bodyTokenSet,
      doc.bodyLemmaSet,
      { requireContiguous: true }
    ),
  };
}

function configuredConceptMatch(query: AnalyzedQuery, doc: IndexedDocument): ConfiguredConceptMatch {
  const title = configuredConceptFieldEvidence(query, doc).title;
  if (title === "key") return "key-in-title";
  if (title === "form") return "form";
  return false;
}

function morphologyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) {
    const acr = query.concepts.find((c) => c.kind === "configured-concept");
    for (const form of peerFormsOf(acr)) {
      if (form.length !== 1) continue;
      const tok = form[0];
      if (!tok || DEFAULT_STOP.has(tok)) continue;
      const lemmaHit = doc.titleLemmaSet.has(tok) || doc.titleTokenSet.has(tok);
      if (lemmaHit && !doc.titleTokenSet.has(tok)) return true;
    }
    return false;
  }
  return evidenceTokens(query).some((t) => {
    const lemma = t.lemma || t.normalized;
    if (!lemma) return false;
    const lemmaHit = doc.titleLemmaSet.has(lemma) || doc.titleTokenSet.has(lemma);
    if (!lemmaHit) return false;
    return !doc.titleTokenSet.has(t.normalized);
  });
}

function typoDistance(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) return 0;
  let best = 0;
  for (const t of identityTokens(query)) {
    if (isBoundTrailingTypedToken(query, t)) continue;
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

function versionMatch(query: AnalyzedQuery, doc: IndexedDocument): VersionMatch {
  const v = versionHit(query, doc);
  if (!v) return false;
  if (v.dottedHit && (v.companion === "covered" || v.companion === "absent")) return "dotted";
  if (v.compactHit && v.companion === "covered") return "compact-dotted";
  if (v.compactHit && v.companion === "absent") return "compact-weak";
  if (v.compactHit && v.companion === "weak") return "compact-weak";
  if (v.dottedHit) return "dotted-weak";
  return false;
}

function shortLiteralLeadMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  if (hasConfiguredSequenceIntent(query)) return false;
  const tok =
    query.tokens.length === 1 && query.tokens[0].normalized.length <= 3
      ? query.tokens[0].normalized
      : shortTitleTokenPrefixStub(query);
  if (tok == null) return false;
  if (!doc.firstToken) return false;
  return doc.firstToken === tok || doc.firstToken.startsWith(tok);
}

function dottedSpanComponentTitleMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const spans = doc.dottedSpans || [];
  if (!spans.length) return false;
  return query.tokens.some((t) => {
    const forms = [t.normalized, t.surfaceNormalized, t.surface];
    return forms.some((f) => queryTokenMatchesDottedSpanComponent(f, spans));
  });
}

function adjacentOn(queryToks: string[], fieldToks: string[]) {
  if (queryToks.length < 2 || fieldToks.length < queryToks.length) return false;
  for (let i = 0; i <= fieldToks.length - queryToks.length; i++) {
    let ok = true;
    for (let j = 0; j < queryToks.length; j++) {
      const qt = queryToks[j];
      const tt = fieldToks[i + j];
      if (!tt) {
        ok = false;
        break;
      }
      const digitSafe = /^\d+$/.test(qt) || /^\d+$/.test(tt) ? tt === qt : tt === qt || tt.startsWith(qt);
      if (!digitSafe) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function phraseAdjacency(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = query.concepts.find((c) => c.kind === "configured-concept") || null;
  const forms = hasConfiguredSequenceIntent(query) ? peerFormsOf(acr) : [];
  if (forms.length) {
    let best = 0;
    for (const form of forms) {
      if (form.length < 2) continue;
      if (adjacentOn(form, doc.titleTokens) || adjacentOn(form, doc.titleLemmas)) return 1;
      if (adjacentOn(form, doc.bodyTokens) || adjacentOn(form, doc.bodyLemmas)) best = Math.max(best, 0.5);
    }
    return best;
  }
  const qToks = queryNonStop(query).map((t) => t.normalized);
  const qLemmas = queryNonStop(query).map((t) => t.lemma || t.normalized);
  if (qToks.length < 2) return 0;
  if (adjacentOn(qToks, doc.titleTokens) || adjacentOn(qLemmas, doc.titleLemmas)) return 1;
  if (adjacentOn(qToks, doc.bodyTokens) || adjacentOn(qLemmas, doc.bodyLemmas)) return 0.5;
  return 0;
}

function configuredFormEvidence(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return 0;
  const forms = peerFormsOf(acr);
  if (!forms.length) return 0;
  let best = 0;
  for (const form of forms) {
    const content = formContentTokens(form);
    if (!content.length) continue;
    if (form.length === 1) {
      if (doc.titleTokenSet.has(content[0]) || doc.titleLemmaSet.has(content[0])) best = Math.max(best, 1);
      continue;
    }
    const phrase =
      exactTokenSequence(form, doc.titleTokens) || exactTokenSequence(form, doc.titleLemmas);
    const hits = content.filter((f) => doc.titleTokenSet.has(f) || doc.titleLemmaSet.has(f));
    if (!phrase && hits.length < 2) continue;
    const score = hits.length / content.length;
    if (score > best) best = score;
  }
  return Number(best.toFixed(4));
}

function occupiedPartialForm(query: AnalyzedQuery) {
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return null;
  if ((acr.matchedFormTokens || 0) < 2) return null;
  const coverage = acr.formCoverage;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return null;
  if (coverage < TWO_THIRDS_QUERY_COVERAGE || coverage >= FULL_QUERY_COVERAGE) return null;
  return acr;
}

function configuredFormCoverage(query: AnalyzedQuery) {
  if (!hasConfiguredSequenceIntent(query)) return 0;
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return 0;
  const coverage = acr.formCoverage;
  return typeof coverage === "number" && Number.isFinite(coverage) ? coverage : 0;
}

function exactTokenSequence(seq: string[], fieldToks: string[]) {
  if (seq.length < 2 || fieldToks.length < seq.length) return false;
  const m = seq.length;
  const last = fieldToks.length - m;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < m; j++) {
      if (fieldToks[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function configuredFormBodyMatch(query: AnalyzedQuery, doc: IndexedDocument) {
  const acr = occupiedPartialForm(query);
  if (!acr) return false;
  const forms = peerFormsOf(acr).filter((form) => form.length >= 3);
  if (!forms.length) return false;
  return forms.some(
    (form) => exactTokenSequence(form, doc.bodyTokens) || exactTokenSequence(form, doc.bodyLemmas)
  );
}

function queryIsConfiguredKey(query: AnalyzedQuery) {
  if (hasConfiguredSequenceIntent(query)) return false;
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return false;
  if (query.tokens.length !== 1) return false;
  return query.tokens[0].normalized === acr.id;
}

function canonicalKeyTitle(query: AnalyzedQuery, doc: IndexedDocument) {
  if (!queryIsConfiguredKey(query)) return false;
  const acr = query.concepts.find((c) => c.kind === "configured-concept");
  if (!acr) return false;
  const keyInTitle = doc.titleTokenSet.has(acr.id) || doc.titleLemmaSet.has(acr.id);
  if (!keyInTitle) return false;
  return configuredFormEvidence(query, doc) >= 0.5;
}

function lexicalCoverageFields(query: AnalyzedQuery, doc: IndexedDocument) {
  const concepts = rankingCoverageConcepts(query, query.concepts || []);
  let coverageConceptCount = 0;
  let bodyHits = 0;
  let unionHits = 0;
  for (const c of concepts) {
    if (isSearchEquivalenceRecallConcept(query, c)) continue;
    coverageConceptCount += 1;
    const body = conceptMatchesBody(c, doc, query);
    if (body) {
      bodyHits += 1;
      unionHits += 1;
      continue;
    }
    if (conceptMatchesTitle(c, doc, query) != null) unionHits += 1;
  }
  if (!coverageConceptCount) {
    return { coverageConceptCount: 0, bodyLexicalMatch: 0, lexicalConceptCoverage: 0 };
  }
  return {
    coverageConceptCount,
    bodyLexicalMatch: Number((bodyHits / coverageConceptCount).toFixed(4)),
    lexicalConceptCoverage: Number((unionHits / coverageConceptCount).toFixed(4)),
  };
}

function lexicalPhraseQueryTokens(query: AnalyzedQuery) {
  if (Array.isArray(query.lexicalTokens) && query.lexicalTokens.length) return query.lexicalTokens;
  return query.tokens;
}

function lexicalQueryNonStop(query: AnalyzedQuery) {
  const tokens = lexicalPhraseQueryTokens(query);
  const toks = tokens.filter((t) => !DEFAULT_STOP.has(t.normalized) || tokens.length <= 2);
  return toks.length ? toks : tokens;
}

function phraseKeyCandidates(query: AnalyzedQuery) {
  const acr = query.concepts.find((c) => c.kind === "configured-concept") || null;
  const occupiedForms = Array.isArray(query.peerFormLexical) && query.peerFormLexical.length
    ? query.peerFormLexical
    : hasConfiguredSequenceIntent(query)
      ? peerFormsOf(acr)
      : [];
  if (occupiedForms.length) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const form of occupiedForms) {
      if (form.length < 2) continue;
      const toks = form.map((word) => word);
      const key = toks.join(" ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (toks.length >= 3) {
        const left = toks.slice(0, 2).join(" ");
        if (left && !seen.has(left)) {
          seen.add(left);
          keys.push(left);
        }
      }
    }
    keys.sort();
    return keys;
  }
  const source = lexicalPhraseQueryTokens(query);
  const toks = canonicalLexicalTokensFromQuery(source);
  if (!toks.length) return [];
  const keys = [toks.join(" ")];
  if (hasBoundContextualCompletion(query) && toks.length >= 3) {
    for (const ng of extractCanonicalNgrams(toks, { minN: 2, maxN: 2 })) {
      if (ng && !keys.includes(ng)) keys.push(ng);
    }
  }
  const pc = query.prefixCompletion;
  // Ambiguous completions are explain/provenance only. They must not mint
  // alternate compiled phrase keys or pick a max bodyPhraseCount.
  if (!pc || pc.ambiguous || !pc.completedToken || !pc.canonicalToken) return keys;
  const head = canonicalLexicalTokensFromQuery(source.slice(0, -1));
  const key = head.length ? [...head, pc.canonicalToken].join(" ") : String(pc.canonicalToken);
  if (key && !keys.includes(key)) keys.push(key);
  return keys;
}

function typedPhraseFieldFrequencies(query: AnalyzedQuery, doc: IndexedDocument) {
  const tokens = (query.originalSurface || []).filter(Boolean);
  if (tokens.length < 2) {
    return { titlePhraseFrequency: 0, summaryPhraseFrequency: 0, exactTitleOrSummaryPhrase: false };
  }
  const titlePhraseFrequency = sequenceCount(tokens, doc.titleTokens);
  const summaryPhraseFrequency = sequenceCount(tokens, doc.summaryTokens || []);
  return {
    titlePhraseFrequency,
    summaryPhraseFrequency,
    exactTitleOrSummaryPhrase: titlePhraseFrequency > 0 || summaryPhraseFrequency > 0,
  };
}

function compiledPhraseLookup(query: AnalyzedQuery, doc: IndexedDocument) {
  const candidates = phraseKeyCandidates(query);
  const ngrams = doc.lexicalFrequency || null;
  const primary = primaryPhraseOf(candidates);
  let matchingPhraseKey: string | null = null;
  let count = 0;
  const firstPositive = hasBoundContextualCompletion(query) && candidates.length > 1;
  for (const key of candidates) {
    const n = key && ngrams && Number.isFinite(ngrams[key]) ? ngrams[key] : 0;
    if (firstPositive) {
      if (n > 0) {
        matchingPhraseKey = key;
        count = n;
        break;
      }
      continue;
    }
    if (n > count || (n === count && n > 0 && matchingPhraseKey != null && key < matchingPhraseKey)) {
      count = n;
      matchingPhraseKey = key;
    }
  }
  return {
    normalizedQueryPhrase: primary,
    matchingPhraseKey: count > 0 ? matchingPhraseKey : null,
    bodyPhraseCount: count,
    bodyPhraseFrequency: saturatingFrequency(count),
  };
}

function contextualFeatureFields(contextual: ContextualTitlePrefix | null) {
  if (!contextual) {
    return {
      contextualTitlePrefix: false,
      matchedPrefixTokens: [],
      activeFinalPrefix: null,
      completedTitleToken: null,
      unmatchedTitleTokensAfter: 0,
      titleSequenceTightness: 0,
      contextualPrefixQuality: 0,
    };
  }
  return {
    contextualTitlePrefix: true,
    matchedPrefixTokens: contextual.matchedPrefixTokens,
    activeFinalPrefix: contextual.activeFinalPrefix,
    completedTitleToken: contextual.completedTitleToken,
    unmatchedTitleTokensAfter: contextual.unmatchedTitleTokensAfter,
    titleSequenceTightness: contextual.titleSequenceTightness,
    contextualPrefixQuality: contextual.contextualPrefixQuality,
  };
}

export function extractFeaturesOracle(
  query: AnalyzedQuery,
  doc: IndexedDocument,
  { relationship = null, retrievalScore = 0 }: { relationship?: RelationshipInfo | null; retrievalScore?: number } = {}
): FeatureVector {
  const phrase = compiledPhraseLookup(query, doc);
  const contextual = hasConfiguredSequenceIntent(query) ? null : matchContextualTitlePrefix(query, doc);
  const fieldEvidence = configuredConceptFieldEvidence(query, doc);
  const base: FeatureVector = {
    exactTitleMatch: exactTitle(query, doc),
    exactTitleTokenMatch: exactTitleTokenMatch(query, doc),
    typedSurfaceTitleMatch: typedSurfaceTitleMatch(query, doc),
    titleCoverage: titleCoverage(query, doc),
    queryCoverage: queryCoverage(query, doc),
    titlePrefixQuality: titlePrefixQuality(query, doc),
    ...contextualFeatureFields(contextual),
    configuredConceptMatch: fieldEvidence.title === "key" ? "key-in-title" : fieldEvidence.title === "form" ? "form" : false,
    configuredConceptFieldEvidence: fieldEvidence,
    morphologyMatch: morphologyMatch(query, doc),
    typoDistance: typoDistance(query, doc),
    versionMatch: versionMatch(query, doc),
    shortLiteralLeadMatch: shortLiteralLeadMatch(query, doc),
    dottedSpanComponentTitleMatch: dottedSpanComponentTitleMatch(query, doc),
    phraseAdjacency: phraseAdjacency(query, doc),
    ...lexicalCoverageFields(query, doc),
    titleTokenCount: doc.nonStopTitle.length,
    configuredFormEvidence: configuredFormEvidence(query, doc),
    configuredFormCoverage: configuredFormCoverage(query),
    configuredFormBodyMatch: configuredFormBodyMatch(query, doc),
    canonicalKeyTitle: canonicalKeyTitle(query, doc),
    queryTokenCount: hasConfiguredSequenceIntent(query)
      ? Math.max(1, ...peerFormsOf(query.concepts.find((c) => c.kind === "configured-concept")).map((form) => formContentTokens(form).length))
      : lexicalQueryNonStop(query).length,
    normalizedQueryPhrase: phrase.normalizedQueryPhrase,
    matchingPhraseKey: phrase.matchingPhraseKey,
    bodyPhraseCount: phrase.bodyPhraseCount,
    bodyPhraseFrequency: phrase.bodyPhraseFrequency,
    ...typedPhraseFieldFrequencies(query, doc),
    configuredPrefixRecallScore: 0,
    relationshipStrength: relationship?.strength || 0,
    relationshipType: relationship?.type ?? null,
    relationshipSourceId: relationship?.sourceId ?? null,
    retrievalScore: retrievalScore || 0,
    relevanceKind: "direct",
    directClass: "none",
  };
  base.directClass = classifyDirectOracle(base);
  base.relevanceKind = relationship && base.directClass === "none" ? "related" : "direct";
  return base;
}

/**
 * Interpretable direct-evidence class from named features. Not a float score.
 *   strong   — exact title, configured key-in-title, canonical form title, full coverage, dotted version
 *   moderate — meaningful title match / high query coverage / peer form / phrase
 *   weak     — incidental title token or body-only overlap
 *   none     — no lexical evidence (typical of a pure related neighbor)
 */
export function classifyDirectOracle(f: Partial<FeatureVector>): DirectClass {
  if (
    f.exactTitleMatch ||
    f.configuredConceptMatch === "key-in-title" ||
    f.canonicalKeyTitle ||
    ((f.queryCoverage || 0) >= FULL_QUERY_COVERAGE &&
      (f.titlePrefixQuality || 0) >= STRONG_WITH_FULL_COVERAGE_TITLE_PREFIX_QUALITY) ||
    f.versionMatch === "compact-dotted" ||
    f.versionMatch === "dotted"
  ) {
    return "strong";
  }
  if (
    (f.queryCoverage || 0) >= TWO_THIRDS_QUERY_COVERAGE ||
    (f.titlePrefixQuality || 0) >= MODERATE_TITLE_PREFIX_QUALITY ||
    f.configuredConceptMatch === "form" ||
    (f.configuredFormEvidence || 0) >= TWO_THIRDS_QUERY_COVERAGE ||
    f.configuredFormBodyMatch ||
    f.phraseAdjacency === 1 ||
    f.exactTitleOrSummaryPhrase ||
    f.shortLiteralLeadMatch ||
    f.dottedSpanComponentTitleMatch ||
    (f.exactTitleTokenMatch && (f.queryCoverage || 0) > 0) ||
    ((f.queryTokenCount || 0) >= 2 && (f.bodyPhraseCount || 0) >= REPEATED_BODY_PHRASE_MIN) ||
    f.contextualTitlePrefix
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
    f.configuredConceptMatch ||
    Boolean(f.configuredConceptFieldEvidence?.summary) ||
    Boolean(f.configuredConceptFieldEvidence?.body)
  ) {
    return "weak";
  }
  return "none";
}

export const FEATURE_DEFINITIONS = {
  exactTitleMatch: "True when normalized query equals the full normalized title.",
  exactTitleTokenMatch: "True when a non-stop canonical query token occurs as an independent title token (not a digit split from a dotted numeric span such as 1.2). Unique prefix completions and morphology use the lemma; typed stubs and completedToken are not exact surface evidence. A trailing stub bound by unique contextual expansion completion is not unbound exact-title-token evidence.",
  typedSurfaceTitleMatch: "True when the typed/repaired surface (before lemma or unique-prefix rewrite) occurs as an independent title token or is a legitimate prefix of one. Digits produced by splitting a dotted span are not typed-surface evidence. Canonical retrieval lemmas are not typed-surface evidence. A trailing stub bound by unique contextual expansion completion is not unbound title-prefix evidence.",
  titleCoverage: "Fraction of non-stop title tokens accounted for by the query. A trailing stub bound by unique contextual expansion completion is excluded.",
  queryCoverage: "Fraction of query concepts evidenced in the title (or via a legitimate version alias). A trailing term concept bound by unique contextual expansion completion is excluded.",
  titlePrefixQuality: "How completely query tokens prefix title tokens, tightened by extra title tokens. A trailing stub bound by unique contextual expansion completion is excluded.",
  contextualTitlePrefix: "True when preceding query tokens align with the title start and only the final token is a proper prefix of the aligned title token.",
  matchedPrefixTokens: "Preceding query tokens that aligned exactly/canonically with the title start.",
  activeFinalPrefix: "Final query token used as a contextual title prefix, or null.",
  completedTitleToken: "Title token completed by the contextual final prefix, or null.",
  unmatchedTitleTokensAfter: "Count of title tokens after the aligned final-token completion (0 when the title ends at the completed token).",
  titleSequenceTightness: "1 / (1 + unmatchedTitleTokensAfter). Prefer titles that complete the query and end there.",
  contextualPrefixQuality: "completeness * titleSequenceTightness, where completeness is finalPrefix.length / completedTitleToken.length.",
  configuredConceptMatch: "Configured-concept title match: key-in-title | form | false.",
  morphologyMatch: "Query lemma matches a title token/lemma while surface may differ. A trailing stub bound by unique contextual expansion completion is excluded.",
  typoDistance: "0–2 style evidence: 0 none, 1 repeat-collapse or edit-distance 2, 2 edit-distance 1.",
  versionMatch: "false | compact-weak | compact-dotted | dotted | dotted-weak.",
  shortLiteralLeadMatch: "Short query (≤3) matches the first surface title token as exact or prefix.",
  dottedSpanComponentTitleMatch: "True when a typed all-digit query token equals a component of a dotted numeric title span (the 2 in 1.2). Not independent exact-title evidence and not a versionMatch.",
  phraseAdjacency: "1 title-adjacent query tokens, 0.5 body-adjacent, else 0.",
  bodyLexicalMatch: "Fraction of query concepts evidenced in the body field.",
  lexicalConceptCoverage: "Fraction of typed/configured coverage concepts with lexical evidence in the title OR the body. Each concept counts once.",
  coverageConceptCount: "Count of typed/configured coverage concepts (search-equivalence recall concepts excluded).",
  titleTokenCount: "Non-stop title token count; used for tightness, not as a boost constant.",
  configuredFormEvidence: "Max over peer forms of (non-stop title hits / that form's non-stop length). A single content token from a multi-token form is not configured identity.",
  configuredFormCoverage: "Occupied matched-form completeness from query analysis (0 when the query does not uniquely occupy a configured concept). Unique occupancy is not completeness; a 2/3 prefix remains 2/3.",
  configuredFormBodyMatch: "True when an unambiguous partial configured-form prefix (at least 2 tokens and 2/3 coverage, not a complete form) has that contiguous peer form in the body.",
  canonicalKeyTitle: "True when the query is exactly a configured key and the title also states most of a peer form.",
  queryTokenCount: "Non-stop analyzed query token count. Occupied concepts use the max non-stop length of one peer form; this summary is not a lexical scoring denominator.",
  normalizedQueryPhrase: "Lemmatized non-stop query tokens joined as the compiled n-gram lookup key. An incomplete final token may be completed through vocabulary+morphology first.",
  matchingPhraseKey: "Compiled n-gram key that matched, or null when the count is 0.",
  bodyPhraseCount: "Build-time integer occurrence count of the normalized query phrase in this document BODY. 0 if missing.",
  bodyPhraseFrequency: "Bounded transform log1p(count)/(1+log1p(count)) of bodyPhraseCount.",
  titlePhraseFrequency: "Exact typed-surface originalSurface occurrences in the title field.",
  summaryPhraseFrequency: "Exact typed-surface originalSurface occurrences in the optional summary field.",
  exactTitleOrSummaryPhrase: "True when the complete typed phrase occurs in title or summary.",
  relationshipStrength: "0–1 strength of a precomputed document relationship used for related-result ranking. 0 if none.",
  relationshipType: "Relationship type (semantic, same-category, …) or null. Not a query equivalence.",
  relationshipSourceId: "Primary document id that licensed this related candidate, or null.",
  retrievalScore: "Optional 0–1 retrieval evidence (e.g. normalized BM25). Default 0; not a substitute for constraints.",
  relevanceKind: "direct | related. Related never counts as direct-intent evidence.",
  directClass: "strong | moderate | weak | none. Interpretable lexical evidence class, independent of relatedness.",
};
