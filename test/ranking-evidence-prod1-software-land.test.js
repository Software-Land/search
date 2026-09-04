import {
  SearchEngine,
  compileAuthoredRelevance,
  morphology,
} from "../dist/index.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import {
  loadSoftwareLandJson,
  loadSoftwareLandRelevanceInputs,
} from "./helpers/software-land-fixture.js";
import { enforcedV1HistoricalTopNRows } from "./helpers/v1-historical-topn-contract.js";
import { RankingEvidenceSessionPool } from "../dist/rankingEvidenceState.js";
import {
  releaseEvidence,
  runEvidence,
} from "./helpers/ranking-evidence-prod1.js";

function rowsFrom(payload) {
  return [...(payload.cases || []), ...(payload.overlayCases || [])];
}

function addResult(total, reason, candidates, primitiveMismatches, scoreMismatches) {
  total.queries += 1;
  if (reason) {
    total.ineligible += 1;
    total.reasons[reason] = (total.reasons[reason] || 0) + 1;
    return;
  }
  total.eligible += 1;
  total.candidates += candidates;
  total.primitiveMismatches += primitiveMismatches;
  total.scoreMismatches += scoreMismatches;
}

function emptyTotal() {
  return {
    queries: 0,
    eligible: 0,
    ineligible: 0,
    candidates: 0,
    primitiveMismatches: 0,
    scoreMismatches: 0,
    reasons: {},
  };
}

test("Software.Land historical, v1, v2, and regression fused eligibility/exactness audit", async () => {
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
  const authored = compileAuthoredRelevance({ configuredConcepts, relationshipMap });
  const plugins = [morphology({ lemmas }), ...authored.plugins];
  const indexedDocuments = attachLexicalFrequency(documents, lexicalFrequency);
  const lexicalIndex = compileLexicalIndex(indexedDocuments, { schema, plugins });
  const engine = SearchEngine.create({
    schema,
    plugins,
    lexicalIndex,
    documentRelationships: relationships,
    relationshipStrategy: "hybrid",
    retriever: "indexed",
  });
  await engine.index(indexedDocuments);

  const suites = {
    historical: historical.rows.filter((row) => row.query),
    v1OnV2: enforcedV1HistoricalTopNRows(historical.rows).filter((row) => row.query),
    v2: rowsFrom(loadSoftwareLandJson("v2-contracts.json")).filter((row) => row.query),
    regression: rowsFrom(loadSoftwareLandJson("regression-scenarios.json")).filter(
      (row) => row.query
    ),
  };
  suites.unique = [
    ...new Set(
      Object.values(suites)
        .flat()
        .map((row) => row.query)
    ),
  ].map((query) => ({ query }));
  const pool = new RankingEvidenceSessionPool();
  const queryAudit = new Map();
  const totals = {};

  function audit(rawQuery) {
    const cached = queryAudit.get(rawQuery);
    if (cached) return cached;
    const run = runEvidence(engine, rawQuery, { pool });
    try {
      const result = !run.eligible
        ? { reason: run.reason, candidates: 0, primitiveMismatches: 0, scoreMismatches: 0 }
        : {
            reason: null,
            candidates: run.diff.candidates,
            primitiveMismatches: run.diff.primitiveMismatches,
            scoreMismatches: run.diff.scoreMismatches,
            samples: run.diff.samples,
          };
      queryAudit.set(rawQuery, result);
      return result;
    } finally {
      releaseEvidence(run);
    }
  }

  for (const [suite, rows] of Object.entries(suites)) {
    const total = emptyTotal();
    totals[suite] = total;
    for (const row of rows) {
      const result = audit(row.query);
      addResult(
        total,
        result.reason,
        result.candidates,
        result.primitiveMismatches,
        result.scoreMismatches
      );
      if (result.samples?.length) {
        throw new Error(
          `${suite} ${JSON.stringify(row.query)} evidence mismatch: ${JSON.stringify(
            result.samples
          )}`
        );
      }
    }
  }

  const aggregate = Object.entries(totals)
    .filter(([suite]) => suite !== "unique")
    .reduce((out, [, row]) => {
    out.queries += row.queries;
    out.eligible += row.eligible;
    out.ineligible += row.ineligible;
    out.candidates += row.candidates;
    out.primitiveMismatches += row.primitiveMismatches;
    out.scoreMismatches += row.scoreMismatches;
    for (const [reason, count] of Object.entries(row.reasons)) {
      out.reasons[reason] = (out.reasons[reason] || 0) + count;
    }
    return out;
    }, emptyTotal());
  aggregate.eligibilityPct = Number(
    ((100 * aggregate.eligible) / Math.max(aggregate.queries, 1)).toFixed(2)
  );

  expect(aggregate.primitiveMismatches).toBe(0);
  expect(aggregate.scoreMismatches).toBe(0);
  expect(totals.unique).toMatchObject({
    queries: 189,
    eligible: 94,
    ineligible: 95,
    candidates: 2011,
    primitiveMismatches: 0,
    scoreMismatches: 0,
  });
  expect(queryAudit.size).toBe(189);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceSoftwareLand: { totals, aggregate } }));
}, 300_000);
