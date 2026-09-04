/**
 * Software.Land 192-concept / 123-document configured-prefix blast.
 * Reports occupancy vs weak-recall vs fail-closed against the live fixture.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";

const WATCH = [
  "national",
  "basically",
  "amazon",
  "central",
  "security",
  "key",
  "general",
  "semantic",
  "role",
  "platform",
  "function",
  "mutual",
  "identity and",
  "create read",
  "basically available",
];

function prefixQueries(entries) {
  const out = new Set();
  for (const entry of entries) {
    for (const alias of entry.aliases || []) {
      const form = Array.isArray(alias) ? alias.map((t) => String(t).toLowerCase()) : [];
      if (form.length < 2) continue;
      for (let k = 1; k < form.length; k++) {
        out.add(form.slice(0, k).join(" "));
        const last = form[k];
        if (last && last.length > 1) {
          for (let n = 1; n < last.length && n <= 4; n++) {
            out.add([...form.slice(0, k), last.slice(0, n)].join(" "));
          }
        }
      }
    }
  }
  return [...out].sort();
}

function oldOccupancyWouldFire(q) {
  const intent = q.configuredSequenceIntent;
  if (!intent?.key || !intent.matchedForm?.length) return false;
  const k = (q.tokens || []).length;
  const n = intent.matchedForm.length;
  if (k >= n) return true;
  const last = q.tokens[k - 1];
  const want = intent.matchedForm[k - 1];
  const typed = String(last?.surfaceNormalized || last?.normalized || "").toLowerCase();
  const lastExact = typed === String(want || "");
  const coverage = k / n;
  if (!lastExact) return coverage >= 2 / 3;
  return coverage >= 2 / 3;
}

describe("Software.Land configured-prefix blast", () => {
  test("reports recall, occupancy, ambiguity, and prefix-only displacement", async () => {
    const inputs = loadSoftwareLandRelevanceInputs();
    const plugins = [
      morphology({ lemmas: inputs.lemmas }),
      compileConfiguredConceptPlugin({ configuredConcepts: inputs.configuredConcepts }),
    ];
    const engine = SearchEngine.create({
      schema: inputs.schema,
      plugins,
      documentRelationships: inputs.relationships,
      relationshipStrategy: "none",
    });
    await engine.index(inputs.documents);
    const lexicalIndex = compileLexicalIndex(inputs.documents, { schema: inputs.schema, plugins });
    const indexed = SearchEngine.create({
      schema: inputs.schema,
      plugins,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "none",
    });
    await indexed.index(inputs.documents);

    const queries = prefixQueries(inputs.configuredConcepts);
    const recall = [];
    const occupy = [];
    const none = [];
    const newOccupancy = [];
    const stopFinalRecall = [];
    const candidateSetChanged = [];
    const top10OrderChanged = [];
    const lexicalDisplaced = [];
    const weakInterleave = [];
    const watch = {};

    for (const raw of queries) {
      const q = analyzeQuery(raw, { plugins });
      const occupied = Boolean(q.configuredSequenceIntent?.key);
      const prefix = q.configuredPrefixRecall;
      if (occupied) {
        occupy.push(raw);
        if (!oldOccupancyWouldFire(q)) newOccupancy.push(raw);
      } else if (prefix) {
        recall.push({ query: raw, key: prefix.key, coverage: prefix.coverage, lastExact: prefix.lastExact });
        const last = q.tokens[q.tokens.length - 1];
        if (last && ["and", "of", "the", "a", "or"].includes(String(last.normalized))) {
          stopFinalRecall.push(raw);
        }
      } else {
        none.push(raw);
      }

      const detailed = engine.searchDetailed(raw, { limit: 10, relatedLimit: 0, explain: true });
      const search = engine.search(raw, { limit: 10, relatedLimit: 0 });
      if (occupied || prefix) {
        const searchIds = search.map((row) => row.id);
        const detailedIds = detailed.results.map((row) => row.id);
        if (searchIds.join() !== detailedIds.join()) {
          throw new Error(
            `search()!=searchDetailed for ${JSON.stringify(raw)} occupy=${q.configuredSequenceIntent?.key || null} recall=${q.configuredPrefixRecall?.key || null} search=${searchIds.join(",")} detailed=${detailedIds.join()}`
          );
        }
      }

      const prefixOnly = detailed.results.filter(
        (row) => (row.retrievalSources || []).length === 1 && row.retrievalSources[0] === "configured-prefix-recall"
      );
      for (const row of detailed.results) {
        const sources = row.retrievalSources || [];
        const prefixOnlyHit =
          sources.length === 1 && sources[0] === "configured-prefix-recall";
        const prefixScore = Number(row.features?.configuredPrefixRecallScore) || 0;
        if (!prefixOnlyHit && prefixScore) {
          throw new Error(`prefix score leaked onto lexical hit for ${JSON.stringify(raw)} id=${row.id}`);
        }
        if (prefixOnlyHit && row.directClass !== "none" && prefixScore) {
          throw new Error(`prefix score stacked on classed key-only hit for ${JSON.stringify(raw)} id=${row.id} class=${row.directClass}`);
        }
      }
      if (prefixOnly.length) candidateSetChanged.push(raw);
      const firstPrefix = detailed.results.findIndex(
        (row) => (row.retrievalSources || []).length === 1 && row.retrievalSources[0] === "configured-prefix-recall"
      );
      if (firstPrefix >= 0) {
        const later = detailed.results.slice(firstPrefix + 1);
        const laterStrong = later.filter((row) => row.directClass === "moderate" || row.directClass === "strong");
        const laterWeak = later.filter((row) => row.directClass === "weak");
        if (laterStrong.length) lexicalDisplaced.push(raw);
        if (laterWeak.length) {
          weakInterleave.push(raw);
          top10OrderChanged.push(raw);
        }
      }
      if (WATCH.includes(raw)) {
        watch[raw] = {
          occupy: q.configuredSequenceIntent?.key || null,
          recall: prefix ? { key: prefix.key, coverage: prefix.coverage } : null,
          top: detailed.results.map((row) => row.title),
          prefixOnly: prefixOnly.map((row) => row.title),
        };
      }
    }

    for (const raw of WATCH.filter((query) => !queries.includes(query))) {
      const q = analyzeQuery(raw, { plugins });
      const detailed = engine.searchDetailed(raw, { limit: 10, relatedLimit: 0, explain: true });
      watch[raw] = {
        occupy: q.configuredSequenceIntent?.key || null,
        recall: q.configuredPrefixRecall
          ? { key: q.configuredPrefixRecall.key, coverage: q.configuredPrefixRecall.coverage }
          : null,
        top: detailed.results.map((row) => row.title),
        prefixOnly: detailed.results
          .filter((row) => (row.retrievalSources || []).length === 1 && row.retrievalSources[0] === "configured-prefix-recall")
          .map((row) => row.title),
      };
      const search = indexed.search(raw, { limit: 10, relatedLimit: 0 });
      const detailedIdx = indexed.searchDetailed(raw, { limit: 10, relatedLimit: 0 }).results;
      expect(search.map((row) => row.id)).toEqual(detailedIdx.map((row) => row.id));
    }

    const report = {
      queryCount: queries.length,
      occupy: occupy.length,
      recall: recall.length,
      none: none.length,
      newOccupancy: newOccupancy.length,
      stopFinalRecall: stopFinalRecall.length,
      candidateSetChanged: candidateSetChanged.length,
      lexicalDisplaced: lexicalDisplaced.length,
      weakInterleave: weakInterleave.length,
      weakInterleaveQueries: weakInterleave,
      watch,
      newOccupancyQueries: newOccupancy.slice(0, 80),
      recallSample: recall.slice(0, 40),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ configuredPrefixBlast: report }, null, 2));
    expect(recall.length).toBeGreaterThan(50);
    expect(lexicalDisplaced).toEqual([]);
    expect(watch.national.recall?.key).toBe("nist");
    expect(watch.national.top).toContain("TLS 1.2 Vulnerability");
  }, 180000);
});
