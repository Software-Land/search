/**
 * V2 against the OSS-mirrored Software.Land V1 historical top-N contract.
 *
 * Runs the current OSS V2 SearchEngine against every enforced row in the
 * complete 223-row OSS historical mirror (Software.Land source has 224 rows;
 * overlay-owned `integ` is excluded). Enforced count is 222.
 * This is not a V1 engine test and not the broader Software.Land 320 suite.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
} from "./historical-relevance.js";
import { loadSoftwareLandJson, loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";
import {
  V1_HISTORICAL_TOPN_CONTRACT_SHA256,
  V1_HISTORICAL_TOPN_ENFORCED_COUNT,
  V1_HISTORICAL_TOPN_INVENTORY_COUNT,
  V1_HISTORICAL_TOPN_OBSOLETE_QUERY,
  enforcedV1HistoricalTopNRows,
  hashV1HistoricalTopNRows,
} from "./helpers/v1-historical-topn-contract.js";

const contract = loadSoftwareLandJson("v1-historical-topn-contract.json");
const {
  documents,
  configuredConcepts,
  lemmas,
  relationshipMap,
  relationships,
  lexicalFrequency,
  historical,
  schema,
} = loadSoftwareLandRelevanceInputs();

function createV2Engine() {
  const compiled = compileAuthoredRelevance({
    configuredConcepts,
    relationshipMap,
  });
  return SearchEngine.create({
    schema,
    plugins: [morphology({ lemmas }), ...compiled.plugins],
    documentRelationships: relationships,
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

describe("V2 against V1 historical top-N contract", () => {
  let engine;
  const recorded = [];

  beforeAll(async () => {
    engine = createV2Engine();
    await engine.index(attachLexicalFrequency(documents, lexicalFrequency));
  });

  afterAll(() => {
    const passed = recorded.filter((row) => row.ok).length;
    const failed = recorded.filter((row) => !row.ok);
    // Dedicated release-gate line. Do not conflate with the 320 V2 product suite.
    console.log(`V2 against V1 historical top-N contract: ${passed} / ${recorded.length}`);
    if (failed.length) {
      console.log(
        failed
          .map(
            (row) =>
              `FAIL query=${JSON.stringify(row.query)} expected=${JSON.stringify(row.expected)} window=${JSON.stringify(row.window)}`
          )
          .join("\n")
      );
    }
  });

  test("inventory is the complete 223-row OSS historical mirror with exactly one obsolete C row", () => {
    expect(historical.rows).toHaveLength(V1_HISTORICAL_TOPN_INVENTORY_COUNT);
    expect(contract.inventoryCount).toBe(V1_HISTORICAL_TOPN_INVENTORY_COUNT);
    expect(contract.enforcedCount).toBe(V1_HISTORICAL_TOPN_ENFORCED_COUNT);
    expect(contract.rows).toHaveLength(V1_HISTORICAL_TOPN_ENFORCED_COUNT);
    expect(contract.obsolete).toEqual([
      expect.objectContaining({
        index: 115,
        query: V1_HISTORICAL_TOPN_OBSOLETE_QUERY,
        classification: "C",
      }),
    ]);
    expect(historical.rows.filter((row) => String(row.classification).toUpperCase() === "C").map((row) => row.query)).toEqual([
      V1_HISTORICAL_TOPN_OBSOLETE_QUERY,
    ]);
    const coveredByV2 = historical.rows.filter((row) => row.disposition === "omitted-covered-by-v2-contract");
    expect(coveredByV2.length).toBeGreaterThan(0);
    expect(
      coveredByV2.every((row) => contract.rows.some((contractRow) => contractRow.index === row.index && contractRow.query === row.query))
    ).toBe(true);
  });

  test("canonical contract hash matches the OSS-mirrored Software.Land V1 historical contract", () => {
    const derived = enforcedV1HistoricalTopNRows(historical.rows);
    expect(derived).toEqual(contract.rows);
    expect(hashV1HistoricalTopNRows(derived)).toBe(V1_HISTORICAL_TOPN_CONTRACT_SHA256);
    expect(contract.sha256).toBe(V1_HISTORICAL_TOPN_CONTRACT_SHA256);
    expect(contract.engineUnderTest).toBe("v2");
  });

  test("duplicate query strings remain distinct indexed contract rows", () => {
    const indexes = contract.rows.map((row) => row.index);
    expect(new Set(indexes).size).toBe(V1_HISTORICAL_TOPN_ENFORCED_COUNT);
    expect(new Set(contract.rows.map((row) => row.query)).size).toBeLessThan(
      V1_HISTORICAL_TOPN_ENFORCED_COUNT
    );
    const sharde = contract.rows.filter((row) => row.query === "sharde");
    expect(sharde).toHaveLength(2);
    expect(new Set(sharde.map((row) => row.index)).size).toBe(2);
  });

  test("live engine is OSS V2 SearchEngine, not a V1 adapter or frozen titles", () => {
    expect(engine.constructor.name).toBe("SearchEngine");
    expect(typeof engine.search).toBe("function");
    expect(typeof engine.searchDetailed).toBe("function");
    expect(typeof engine.index).toBe("function");
    const detailed = engine.searchDetailed("paas", { limit: 10, explain: true });
    expect(detailed.results.length).toBeGreaterThan(0);
    expect(detailed.results[0].explanation?.query).toBeTruthy();
    expect(detailed.results[0].explanation.query.configuredSequenceIntent?.key).toBe("paas");
    expect(detailed.results.map((hit) => hit.title)).not.toEqual(contract.rows.find((row) => row.query === "paas")?.expectedTop);
  });

  test("NIST prefix family mirrors Software.Land v1 expectedTop/topN", () => {
    const nist = [
      ["national", 2],
      ["national i", 2],
      ["national in", 2],
      ["national institute", 1],
      ["national institute o", 1],
      ["national institute of", 1],
      ["national institute o s", 1],
      ["national institute of s", 1],
    ];
    for (const [query, topN] of nist) {
      const historicalRow = historical.rows.find((row) => row.query === query);
      const contractRow = contract.rows.find((row) => row.query === query);
      expect(historicalRow?.v1).toEqual({
        expectedTop: ["TLS 1.2 Vulnerability"],
        topN,
      });
      expect(contractRow).toEqual({
        index: historicalRow.index,
        query,
        expectedTop: ["TLS 1.2 Vulnerability"],
        titlePrefix: null,
        topN,
      });
    }
    expect(historical.rows.some((row) => row.query === "national institute x")).toBe(false);
    expect(contract.rows.some((row) => row.query === "national institute x")).toBe(false);
  });

  test.each(contract.rows.map((row) => [row.index, row.query, row]))(
    "V2 vs V1 historical top-N: row %s query %s",
    (_index, _query, row) => {
      const titles = engine.search(row.query, { limit: documents.length }).map((hit) => hit.title);
      const evaluation = evaluateHistoricalRelevance(
        {
          index: row.index,
          query: row.query,
          v1: {
            expectedTop: row.expectedTop || undefined,
            titlePrefix: row.titlePrefix || undefined,
            topN: row.topN,
          },
        },
        titles
      );
      recorded.push({ ...evaluation, actualTop10: titles.slice(0, 10) });
      if (!evaluation.ok) {
        const missingRanks = (evaluation.missing || []).map((title) => {
          const rank = titles.findIndex(
            (got) => String(got).replace(/\u200B/g, "").replace(/\s+/g, " ").trim().toLowerCase() ===
              String(title).replace(/\u200B/g, "").replace(/\s+/g, " ").trim().toLowerCase()
          );
          return { title, rank: rank === -1 ? null : rank + 1 };
        });
        throw new Error(
          [
            formatHistoricalRelevanceFailure(evaluation),
            `actualTop10 ${JSON.stringify(titles.slice(0, 10))}`,
            `missingRanks ${JSON.stringify(missingRanks)}`,
          ].join("\n")
        );
      }
    }
  );
});
