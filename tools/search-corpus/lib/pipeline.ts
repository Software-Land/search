import { loadCorpus } from "./loadCorpus.js";
import { collectPhraseInventory, mineExplicitDefinitions, mineInitialismCooccurrence } from "./acronyms.js";
import { classifyCandidates } from "./classify.js";
import { loadDecisions, emptyDecisions } from "./decisions.js";
import { applyLifecycle, LIFECYCLE } from "./lifecycle.js";
import {
  compileEquivalences,
  compileSynonyms,
  compileInspection,
  compileManifest,
  configuredConceptsFromEquivalences,
} from "./compile.js";
import { buildVocabulary, spellingTerms } from "./vocabulary.js";
import { mineSynonymCandidates } from "./synonyms.js";
import { diffInspections } from "./delta.js";
import { annotateReviewQueue } from "./queue.js";
import { hashJson } from "./hash.js";
import type { AnalyzeOptions, AnalyzeResult, CompileOptions } from "../types.js";

export const COMPILER_VERSION: 1 = 1;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round(n: unknown): number {
  return Number(Number(n).toFixed(3));
}

/**
 * Analyze: corpus → generated candidates + lifecycle (no runtime compile required).
 */
export function analyzeCorpus(input?: unknown, { decisions = null, overrides = null, previousInspection = null }: AnalyzeOptions = {}): AnalyzeResult {
  const t0 = now();
  const corpus = loadCorpus(input);
  const documents = corpus.documents || [];
  const tLoad = now();

  const explicit = mineExplicitDefinitions(documents);
  const tAcronym = now();
  const titlePhrases = collectPhraseInventory(documents);
  const cooc = mineInitialismCooccurrence(documents, { titlePhrases });
  const tCooc = now();

  const classified = classifyCandidates([...explicit, ...cooc], documents);
  const tClassify = now();
  const synonymMined = mineSynonymCandidates(documents, {
    acceptedEquivalences: classified.filter((c) => c.status === "accepted").map((c) => ({ key: c.key, expansion: c.expansion })),
  });
  const tSyn = now();

  const decisionDoc = loadDecisions(decisions || overrides || emptyDecisions());
  const tDecisions = now();
  const lifeRaw = applyLifecycle(classified, synonymMined, decisionDoc);
  const acceptedKeys = new Set(
    lifeRaw.equivalences
      .filter((c) => c.lifecycle === LIFECYCLE.AUTO_ACCEPTED || c.lifecycle === LIFECYCLE.HUMAN_ACCEPTED)
      .map((c) => c.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0)
  );
  const tLife = now();
  const life = {
    ...lifeRaw,
    equivalences: annotateReviewQueue(lifeRaw.equivalences, { acceptedKeys }),
    synonyms: annotateReviewQueue(lifeRaw.synonyms, { acceptedKeys }),
  };
  const tQueue = now();
  const inspectionDraft = compileInspection(life);
  const delta = diffInspections(inspectionDraft, previousInspection);
  const inspection = compileInspection(life, { delta });
  const tInspect = now();

  const timings = {
    loadMs: round(tLoad - t0),
    acronymMiningMs: round(tAcronym - tLoad),
    cooccurrenceMs: round(tCooc - tAcronym),
    classifyMs: round(tClassify - tCooc),
    synonymMs: round(tSyn - tClassify),
    lifecycleMs: round(tLife - tDecisions),
    queueMs: round(tQueue - tLife),
    inspectionMs: round(tInspect - tQueue),
    totalMs: round(now() - t0),
  };

  return {
    documents: documents.length,
    documentRecords: documents,
    decisionDoc,
    classified,
    inspection,
    timings,
    corpusHash: hashJson(documents.map((d) => ({ id: d.id, title: d.title, body: d.body }))),
    decisionsHash: hashJson(decisionDoc),
    life,
  };
}

/**
 * Compile trusted runtime artifacts from an analysis (or by re-analyzing).
 */
export function compileAnalysis(analysis: AnalyzeResult) {
  const equivalences = compileEquivalences(analysis.life.equivalences);
  const synonyms = compileSynonyms(analysis.life.synonyms);
  const vocabulary = buildVocabulary(analysis.documentRecords, { acceptedEquivalences: equivalences.entries });
  const spelling = spellingTerms(vocabulary);
  const manifest = compileManifest({
    corpusHash: analysis.corpusHash,
    decisionsHash: analysis.decisionsHash,
    inspection: analysis.inspection,
    equivalences: { format: equivalences.format, version: equivalences.version, entries: equivalences.entries },
    synonyms,
    timings: analysis.timings,
  });
  return {
    equivalences: { format: equivalences.format, version: equivalences.version, entries: equivalences.entries },
    synonyms,
    vocabulary,
    spellingTerms: spelling,
    manifest,
    compileWarnings: equivalences.compileWarnings || [],
    configuredConcepts: configuredConceptsFromEquivalences(equivalences),
  };
}

/**
 * Analyze + compile. `overrides` remains as a legacy compatibility alias
 * for decisions ({ accept, reject, add }).
 */
export function compileCorpus(input?: unknown, { overrides = null, decisions = null, previousInspection = null }: CompileOptions = {}) {
  const analysis = analyzeCorpus(input, { decisions: decisions || overrides, previousInspection });
  const compiled = compileAnalysis(analysis);
  return {
    documents: analysis.documents,
    equivalences: compiled.equivalences,
    synonyms: compiled.synonyms,
    vocabulary: compiled.vocabulary,
    spellingTerms: compiled.spellingTerms,
    inspection: analysis.inspection,
    manifest: compiled.manifest,
    timings: analysis.timings,
    configuredConcepts: compiled.configuredConcepts,
    compileWarnings: compiled.compileWarnings,
    corpusHash: analysis.corpusHash,
    decisionsHash: analysis.decisionsHash,
  };
}
