#!/usr/bin/env node
/**
 * Investigation / future-work harness: phrase-candidate taxonomy and a
 * counterfactual title-first score-bound. Uses full extractFeatures as the
 * oracle. Does not change SearchEngine. Not packed. Not a CI gate. Not an SLA.
 *
 *   node scripts/lazy-feature-profile.mjs --n 25000
 */
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { extractFeatures, classifyDirect } from "../dist/features.js";
import { scoreFeatures, selectTopPerBuiltinSignature } from "../dist/rank.js";
import { constraintSignature } from "../dist/rankSignature.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";
import { REPEATED_BODY_PHRASE_MIN } from "../dist/evidencePolicy.js";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const { values } = parseArgs({
  options: {
    n: { type: "string", default: "25000" },
    query: { type: "string", default: "virtual private network" },
    depth: { type: "string", default: "10" },
  },
});
const n = Math.max(1, Number(values.n) || 25000);
const depth = Math.max(1, Number(values.depth) || 10);

function mixedCorpus(size) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
    { id: "probezz", title: "The Probezz", body: "notes" },
  ];
  const rest = Math.max(0, size - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  const articleN = rest - settingsN;
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(articleN, { bodyTokens: 60, seed: SEED ^ 0x22, diverse: false }),
  ];
}

function round6(score) {
  return Number(score.toFixed(6));
}

function phraseCountBand(count) {
  if (!(count > 0)) return 0;
  if (count < REPEATED_BODY_PHRASE_MIN) return 1;
  return 2;
}

function scoreThenIdBetter(scoreA, idA, scoreB, idB) {
  if (scoreA !== scoreB) return scoreA > scoreB;
  return idA < idB;
}

function canBeatWorst(bestScore, bestId, worstScore, worstId) {
  return scoreThenIdBetter(bestScore, bestId, worstScore, worstId);
}

/**
 * Title-first view of a complete FeatureVector: bodyLexicalMatch unknown,
 * phraseAdjacency only if title already produced 1.
 */
function titleFirstPartial(f) {
  const titlePhrase = f.phraseAdjacency === 1 ? 1 : 0;
  const partial = {
    ...f,
    phraseAdjacency: titlePhrase,
    bodyLexicalMatch: 0,
  };
  const directClass = classifyDirect(partial);
  const signature = constraintSignature({ ...partial, directClass, relevanceKind: f.relevanceKind });
  const knownScore = scoreFeatures(partial);
  const maxPhraseRemain = titlePhrase === 1 ? 0 : 0.5 * 0.8;
  const maxBodyLexical = 0.25;
  const upper = knownScore + maxPhraseRemain + maxBodyLexical;
  return {
    titlePhrase,
    titleClass: directClass,
    actualClass: f.directClass,
    signature,
    actualSignature: constraintSignature(f),
    resolved: signature === constraintSignature(f),
    knownScore,
    upper,
    roundedKnown: round6(knownScore),
    roundedUpper: round6(upper),
    roundedActual: round6(scoreFeatures(f)),
    bodyNeededForClass: directClass !== actualClass,
  };
}

const plugins = [
  morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
  dictionary({ entries: [{ key: "tls", expansion: ["transport", "layer", "security"] }] }),
];
const docs = mixedCorpus(n);
const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
const engine = SearchEngine.create({
  schema: SCHEMA,
  plugins,
  lexicalIndex: artifact,
  retriever: "indexed",
  relationshipStrategy: "none",
});
await engine.index(docs);
const detailed = engine._searchDetailedSync(values.query, { limit: depth, relatedLimit: 0 }, false);
const query = engine._prepareQuery(values.query);
const retrieved = engine.retriever.retrieve(query, engine._index, {
  candidateLimit: engine.candidateLimit,
  skipDuplicatePostingLists: true,
});

const rows = [];
for (const hit of retrieved) {
  const features = extractFeatures(query, hit.document, { relationship: hit.relationship || null });
  const score = round6(scoreFeatures(features));
  rows.push({
    id: hit.document.id,
    features,
    score,
    signature: constraintSignature(features),
    partial: titleFirstPartial(features),
  });
}

const selected = selectTopPerBuiltinSignature(
  rows.map((row) => ({ document: { id: row.id }, features: row.features, score: row.score })),
  depth
);
const retainedIds = new Set(selected.candidates.map((c) => c.document.id));

const bySig = new Map();
for (const row of rows) {
  const cur = bySig.get(row.signature) || {
    n: 0,
    retained: 0,
    scores: new Set(),
    classes: new Set(),
    phraseAdj: new Map(),
    bodyLexical: new Map(),
    phraseBand: new Map(),
    titleClass: row.features.directClass,
  };
  cur.n += 1;
  if (retainedIds.has(row.id)) cur.retained += 1;
  cur.scores.add(row.score);
  cur.classes.add(row.features.directClass);
  cur.phraseAdj.set(row.features.phraseAdjacency, (cur.phraseAdj.get(row.features.phraseAdjacency) || 0) + 1);
  const bl = row.features.bodyLexicalMatch;
  cur.bodyLexical.set(bl, (cur.bodyLexical.get(bl) || 0) + 1);
  const band = phraseCountBand(row.features.bodyPhraseCount || 0);
  cur.phraseBand.set(band, (cur.phraseBand.get(band) || 0) + 1);
  bySig.set(row.signature, cur);
}

const signatures = [...bySig.entries()]
  .map(([signature, stats]) => ({
    signature,
    n: stats.n,
    retained: stats.retained,
    distinctScores: stats.scores.size,
    classes: [...stats.classes],
    phraseAdjacency: Object.fromEntries(stats.phraseAdj),
    bodyLexicalMatch: Object.fromEntries(stats.bodyLexical),
    phraseBand: Object.fromEntries(stats.phraseBand),
  }))
  .sort((a, b) => b.n - a.n);

let resolved = 0;
let bodyNeededForClass = 0;
let boundViolations = 0;
for (const row of rows) {
  if (row.partial.resolved) resolved += 1;
  if (row.partial.bodyNeededForClass) bodyNeededForClass += 1;
  if (row.partial.roundedKnown - 1e-12 > row.partial.roundedActual) boundViolations += 1;
  if (row.partial.roundedActual - 1e-12 > row.partial.roundedUpper) boundViolations += 1;
}

function simulate(order, useBound) {
  const heaps = new Map();
  let full = 0;
  let lazyReject = 0;
  let unresolvedFull = 0;
  const rejected = [];
  const falseRejects = [];
  for (const row of order) {
    const sig = row.partial.resolved ? row.partial.signature : null;
    if (!sig || !useBound) {
      full += 1;
      unresolvedFull += row.partial.resolved ? 0 : 1;
      const heap = heaps.get(row.signature) || [];
      heap.push({ score: row.score, id: row.id });
      heap.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1));
      if (heap.length > depth) heap.length = depth;
      heaps.set(row.signature, heap);
      continue;
    }
    const heap = heaps.get(sig) || [];
    if (heap.length < depth) {
      full += 1;
      heap.push({ score: row.score, id: row.id });
      heap.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1));
      heaps.set(sig, heap);
      continue;
    }
    const worst = heap[heap.length - 1];
    if (!canBeatWorst(row.partial.roundedUpper, row.id, worst.score, worst.id)) {
      lazyReject += 1;
      rejected.push(row.id);
      if (retainedIds.has(row.id)) falseRejects.push(row.id);
      continue;
    }
    full += 1;
    heap.push({ score: row.score, id: row.id });
    heap.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1));
    if (heap.length > depth) heap.length = depth;
    heaps.set(sig, heap);
  }
  return { full, lazyReject, unresolvedFull, falseRejects: falseRejects.length, rejected: rejected.length };
}

const currentOrder = simulate(rows, true);
const idOrder = simulate(
  [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)),
  true
);
const knownScoreOrder = simulate(
  [...rows].sort((a, b) => {
    if (b.partial.roundedKnown !== a.partial.roundedKnown) return b.partial.roundedKnown - a.partial.roundedKnown;
    return a.id < b.id ? -1 : 1;
  }),
  true
);

const classCounts = {};
const adjCounts = {};
for (const row of rows) {
  classCounts[row.features.directClass] = (classCounts[row.features.directClass] || 0) + 1;
  adjCounts[row.features.phraseAdjacency] = (adjCounts[row.features.phraseAdjacency] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      n,
      query: values.query,
      matches: retrieved.length,
      documentsFullyEvaluated: detailed.meta.documentsFullyEvaluated,
      C: detailed.meta.candidateCount,
      depth,
      retained: selected.stats.retained,
      signatures: signatures.length,
      maxRepresentativesPerSignature: selected.stats.maxRepresentativesPerSignature,
      classCounts,
      phraseAdjacencyCounts: adjCounts,
      scoreByClass: Object.fromEntries(
        ["strong", "moderate", "weak", "none"].filter((k) => classCounts[k]).map((k) => {
          const scores = rows.filter((r) => r.features.directClass === k).map((r) => r.score);
          scores.sort((a, b) => a - b);
          return [
            k,
            { n: scores.length, min: scores[0], max: scores[scores.length - 1], distinct: new Set(scores).size },
          ];
        })
      ),
      titleFirst: {
        exactSignatureResolved: resolved,
        bodyNeededForClass,
        boundViolations,
      },
      simulateCurrentOrder: currentOrder,
      simulateIdOrder: idOrder,
      simulateKnownScoreOrder: knownScoreOrder,
      topSignatures: signatures.slice(0, 12).map((s) => ({
        n: s.n,
        retained: s.retained,
        distinctScores: s.distinctScores,
        classes: s.classes,
        phraseAdjacency: s.phraseAdjacency,
        bodyLexicalMatch: s.bodyLexicalMatch,
        phraseBand: s.phraseBand,
        class: s.classes[0],
      })),
    },
    null,
    2
  )
);
