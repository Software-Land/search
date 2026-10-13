#!/usr/bin/env node
/**
 * Packed-package Chromium Worker coverage for the frozen Software.Land
 * historical relevance contracts.
 *
 * Path: npm pack → isolated install → real Chromium → SearchClient →
 * packed searchWorker.js → frozen fixture → historical-relevance.js.
 *
 * Does not import src/, does not checkout Software.Land, and does not
 * go through Gatsby/TestCafe.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
  isHistoricalRelevanceApplicable,
} from "../historical-relevance.js";
import {
  documentOverlayScenarioRows,
  loadSoftwareLandDocumentOverlays,
  loadSoftwareLandJson,
  loadSoftwareLandRelevanceInputs,
} from "../helpers/software-land-fixture.js";
import {
  CORPUS_BOOT_MS,
  CORPUS_QUERY_MS,
  attachPageDiagnostics,
  closeServer,
  harnessDir,
  launchChromium,
  preparePackedConsumer,
  startServer,
  writeImportMapHtml,
} from "./pack-harness.mjs";

const CRITICAL_CONTROLS = [
  "recurse",
  "sharde",
  "frames per",
  "ci",
  "continuous integration",
  "cd",
  "continuous deployment",
  "cicd",
  "paas",
  "platform as a service",
  "io",
  "input output",
  "devops",
  "api",
  "authn",
  "authz",
  "http",
  "hypertext",
  "appsec",
  "institute",
  "a*",
];

const EXPANSION_CONTRACTS = [
  {
    query: "open",
    within: { id: "7", title: "SAML vs OAuth", topN: 10 },
  },
  {
    query: "oauth",
    first: { id: "7", title: "SAML vs OAuth" },
  },
  {
    query: "open authorization",
    first: { id: "7", title: "SAML vs OAuth" },
  },
];

function assertExpansionContract(actual, spec) {
  const titles = actual?.titles || [];
  const ids = actual?.ids || [];
  if (spec.first) {
    if (titles[0] !== spec.first.title || ids[0] !== spec.first.id) {
      throw new Error(
        `${JSON.stringify(spec.query)} expected first ${spec.first.id} ${JSON.stringify(spec.first.title)}\n` +
          `actual ${JSON.stringify(ids[0])} ${JSON.stringify(titles[0])}`
      );
    }
  }
  if (spec.within) {
    const windowTitles = titles.slice(0, spec.within.topN);
    const windowIds = ids.slice(0, spec.within.topN);
    if (!windowIds.includes(spec.within.id) || !windowTitles.includes(spec.within.title)) {
      throw new Error(
        `${JSON.stringify(spec.query)} missing ${spec.within.id} ${JSON.stringify(spec.within.title)} within ${spec.within.topN}\n` +
          `ids ${JSON.stringify(windowIds)}\ntitles ${JSON.stringify(windowTitles)}`
      );
    }
  }
}

const ADJUDICATED = {
  recurse: [
    "What is Recursion?",
    "DFS Backtracking",
    "InOrder vs PreOrder vs PostOrder",
    "Dynamic Programming Matrix",
    "React Performance Optimization",
  ],
  sharde: [
    "Sharding",
    "Hot Shards",
    "Throughput vs Latency",
    "CockroachDB vs Postgres",
    "SQL vs NoSQL",
    "gRPC vs Kafka",
  ],
  "frames per": {
    primary: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
    directClass: "moderate",
  },
};

function normalizeQuery(query) {
  return String(query || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatBrowserFailure(row, evaluation, actual) {
  return [
    formatHistoricalRelevanceFailure(evaluation),
    `expected primary ${JSON.stringify(row.intent?.requiredPrimary || [])}`,
    `actual ids ${JSON.stringify(actual?.ids || [])}`,
    `relevanceKind ${JSON.stringify(actual?.relevanceKind || [])}`,
    `directClass ${JSON.stringify(actual?.directClass || [])}`,
    `candidateCount ${actual?.candidateCount ?? null}`,
  ].join("\n");
}

async function runQuery(page, query, options = { limit: 10 }) {
  const generation = await page.evaluate(({ q, opts }) => window.__runQuery(q, opts), {
    q: query,
    opts: options,
  });
  await page.waitForFunction(
    ({ q, gen }) => {
      const s = window.__state;
      if (s.errors.length) return true;
      return Boolean(s.last && s.last.query === q && s.last.generation === gen);
    },
    { q: query, gen: generation },
    { timeout: CORPUS_QUERY_MS }
  );
  const snapshot = await page.evaluate(() => ({
    last: window.__state.last,
    errors: window.__state.errors,
    workerUrl: window.__state.workerUrl,
    retriever: window.__state.retriever,
    documentCount: window.__state.documentCount,
  }));
  if (snapshot.errors.length) {
    throw new Error(`Worker/page errors for ${JSON.stringify(query)}: ${JSON.stringify(snapshot.errors)}`);
  }
  return snapshot.last;
}

async function bootSoftwareLandPage(browser, origin, expectedWorker, retriever, corpus = "frozen") {
  const page = await browser.newPage();
  const diag = attachPageDiagnostics(page);
  await page.goto(
    `${origin}/software-land.html?retriever=${encodeURIComponent(retriever)}&corpus=${encodeURIComponent(corpus)}`,
    {
    waitUntil: "load",
    timeout: CORPUS_BOOT_MS,
  });
  await page.waitForFunction(() => window.__booted === true || window.__bootError, null, {
    timeout: CORPUS_BOOT_MS,
  });
  const boot = await page.evaluate(() => ({
    booted: window.__booted,
    bootError: window.__bootError || null,
    errors: window.__state?.errors || [],
    workerUrl: window.__state?.workerUrl || null,
    retriever: window.__state?.retriever || null,
    documentCount: window.__state?.documentCount ?? null,
  }));
  if (!boot.booted) {
    throw new Error(
      `software-land ${retriever} boot failed: ${boot.bootError || JSON.stringify(boot.errors)}`
    );
  }
  if (boot.errors.length) {
    throw new Error(`software-land ${retriever} init errors: ${JSON.stringify(boot.errors)}`);
  }
  if (!boot.workerUrl || boot.workerUrl !== expectedWorker) {
    throw new Error(
      `software-land ${retriever} Worker was ${boot.workerUrl}, expected packed ${expectedWorker}`
    );
  }
  if (!diag.workers.includes(expectedWorker)) {
    throw new Error(
      `software-land ${retriever} expected packed Worker ${expectedWorker}, observed ${JSON.stringify(diag.workers)}`
    );
  }
  if (boot.retriever !== retriever) {
    throw new Error(`software-land retriever was ${boot.retriever}, expected ${retriever}`);
  }
  diag.assertClean(`software-land ${retriever} boot`);
  return { page, diag, boot };
}

async function main() {
  const started = Date.now();
  const inputs = loadSoftwareLandRelevanceInputs();
  const applicable = inputs.applicable;
  const obsolete = inputs.historical.rows.filter((row) => !isHistoricalRelevanceApplicable(row));
  if (applicable.length !== inputs.historical.counts.historicalRelevanceApplicable) {
    throw new Error(
      `applicable count ${applicable.length} != fixture ${inputs.historical.counts.historicalRelevanceApplicable}`
    );
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "search-chromium-real-corpus-"));
  let server;
  let browser;
  try {
    const packed = await preparePackedConsumer(tmp);
    const lexicalHref = pathToFileURL(
      path.join(packed.installedRoot, packed.lexicalRel)
    ).href;
    const { attachLexicalFrequency } = await import(lexicalHref);
    const documents = attachLexicalFrequency(inputs.documents, inputs.lexicalFrequency);
    const documentOverlays = loadSoftwareLandDocumentOverlays();
    const documentOverlayContracts = documentOverlayScenarioRows(
      loadSoftwareLandJson("v2-contracts.json")
    );
    const overlayDocuments = attachLexicalFrequency(
      [...inputs.documents, ...documentOverlays],
      inputs.lexicalFrequency
    );
    const initPayload = {
      schema: inputs.schema,
      configuredConcepts: inputs.configuredConcepts,
      relationshipMap: inputs.relationshipMap,
      documentRelationships: inputs.relationships,
      relationshipStrategy: "hybrid",
      englishOptions: { lemmas: inputs.lemmas },
    };
    writeFileSync(
      path.join(packed.consumer, "software-land-init.json"),
      JSON.stringify({ ...initPayload, documents })
    );
    writeFileSync(
      path.join(packed.consumer, "software-land-overlay-init.json"),
      JSON.stringify({ ...initPayload, documents: overlayDocuments })
    );
    copyFileSync(path.join(harnessDir, "software-land-app.mjs"), path.join(packed.consumer, "software-land-app.mjs"));
    writeImportMapHtml(packed.consumer, {
      filename: "software-land.html",
      title: "chromium-pack software-land real corpus",
      scriptSrc: "/software-land-app.mjs",
      importMap: packed.importMap,
    });

    const startedServer = await startServer(packed.consumer);
    server = startedServer.server;
    const origin = startedServer.origin;
    const expectedWorker = `${origin}${packed.browserExport.workerHref}`;

    browser = await launchChromium();
    const full = await bootSoftwareLandPage(browser, origin, expectedWorker, "full-scan");
    if (full.boot.documentCount !== inputs.documents.length) {
      throw new Error(
        `Worker documentCount ${full.boot.documentCount} != fixture ${inputs.documents.length}`
      );
    }

    const failures = [];
    const evaluations = [];
    for (const row of applicable) {
      const actual = await runQuery(full.page, row.query, { limit: 10 });
      const evaluation = evaluateHistoricalRelevance(row, actual.titles);
      evaluations.push({
        index: row.index,
        query: row.query,
        ok: evaluation.ok,
      });
      if (!evaluation.ok) {
        failures.push(formatBrowserFailure(row, evaluation, actual));
        break;
      }
    }
    if (failures.length) {
      throw new Error(failures[0]);
    }

    const controls = {};
    for (const query of CRITICAL_CONTROLS) {
      controls[query] = await runQuery(full.page, query, { limit: 10, explain: true });
    }

    const recurseTitles = (controls.recurse?.titles || []).slice(0, ADJUDICATED.recurse.length);
    if (JSON.stringify(recurseTitles) !== JSON.stringify(ADJUDICATED.recurse)) {
      throw new Error(
        `recurse top five mismatch\nexpected ${JSON.stringify(ADJUDICATED.recurse)}\nactual ${JSON.stringify(recurseTitles)}\nids ${JSON.stringify(controls.recurse?.ids || [])}`
      );
    }
    const shardeTitles = (controls.sharde?.titles || []).slice(0, ADJUDICATED.sharde.length);
    if (JSON.stringify(shardeTitles) !== JSON.stringify(ADJUDICATED.sharde)) {
      throw new Error(
        `sharde top six mismatch\nexpected ${JSON.stringify(ADJUDICATED.sharde)}\nactual ${JSON.stringify(shardeTitles)}\nids ${JSON.stringify(controls.sharde?.ids || [])}`
      );
    }
    const frames = controls["frames per"];
    const framesExpected = ADJUDICATED["frames per"];
    if (frames?.titles?.[0] !== framesExpected.primary) {
      throw new Error(
        `frames per primary mismatch: expected ${JSON.stringify(framesExpected.primary)}, got ${JSON.stringify(frames?.titles?.[0])}`
      );
    }
    if (frames?.directClass?.[0] !== framesExpected.directClass) {
      throw new Error(
        `frames per directClass mismatch: expected ${framesExpected.directClass}, got ${JSON.stringify(frames?.directClass?.[0])}`
      );
    }

    const expansion = {};
    for (const spec of EXPANSION_CONTRACTS) {
      expansion[spec.query] = await runQuery(full.page, spec.query, { limit: 10, explain: true });
      assertExpansionContract(expansion[spec.query], spec);
    }

    full.diag.assertClean("software-land full-scan");
    await full.page.evaluate(() => window.__dispose());

    const indexed = await bootSoftwareLandPage(browser, origin, expectedWorker, "indexed");
    const indexedControls = {};
    for (const query of ["recurse", "sharde", "frames per"]) {
      indexedControls[query] = await runQuery(indexed.page, query, { limit: 10, explain: true });
      const fullTitles = (controls[query]?.titles || []).slice(0, 10);
      const indexedTitles = (indexedControls[query]?.titles || []).slice(0, 10);
      if (JSON.stringify(indexedTitles) !== JSON.stringify(fullTitles)) {
        throw new Error(
          `indexed/full-scan title mismatch for ${JSON.stringify(query)}\nfull ${JSON.stringify(fullTitles)}\nindexed ${JSON.stringify(indexedTitles)}`
        );
      }
    }
    for (const spec of EXPANSION_CONTRACTS) {
      const indexedResult = await runQuery(indexed.page, spec.query, { limit: 10, explain: true });
      assertExpansionContract(indexedResult, spec);
      const fullTitles = (expansion[spec.query]?.titles || []).slice(0, 10);
      const indexedTitles = (indexedResult?.titles || []).slice(0, 10);
      if (JSON.stringify(indexedTitles) !== JSON.stringify(fullTitles)) {
        throw new Error(
          `indexed/full-scan title mismatch for ${JSON.stringify(spec.query)}\nfull ${JSON.stringify(fullTitles)}\nindexed ${JSON.stringify(indexedTitles)}`
        );
      }
    }
    indexed.diag.assertClean("software-land indexed smoke");
    await indexed.page.evaluate(() => window.__dispose());

    const documentOverlayResults = {};
    for (const retriever of ["full-scan", "indexed"]) {
      const session = await bootSoftwareLandPage(browser, origin, expectedWorker, retriever, "overlay");
      if (session.boot.documentCount !== overlayDocuments.length) {
        throw new Error(
          `overlay ${retriever} documentCount ${session.boot.documentCount} != ${overlayDocuments.length}`
        );
      }
      const cases = [];
      for (const spec of documentOverlayContracts) {
        const actual = await runQuery(session.page, spec.query, {
          limit: spec.requiredAnyTop?.topN || 10,
          resultCollector: spec.resultCollector || "complete-interpretation",
        });
        if (actual?.query !== spec.query) {
          throw new Error(
            `${spec.name} published ${JSON.stringify(actual?.query)} for ${JSON.stringify(spec.query)}`
          );
        }
        assertExpansionContract(actual, {
          query: spec.query,
          within: {
            id: spec.requiredAnyTop.ids[0],
            title: spec.requiredAnyTop.titles[0],
            topN: spec.requiredAnyTop.topN,
          },
        });
        cases.push({
          name: spec.name,
          query: spec.query,
          ok: true,
          rank: actual.ids.indexOf(spec.requiredAnyTop.ids[0]) + 1,
        });
      }
      session.diag.assertClean(`software-land document overlay ${retriever}`);
      await session.page.evaluate(() => window.__dispose());
      await session.page.close();
      documentOverlayResults[retriever] = cases;
    }

    const uniqueExact = new Set(applicable.map((row) => row.query));
    const uniqueNormalized = new Set(applicable.map((row) => normalizeQuery(row.query)));
    const summary = {
      ok: true,
      elapsedMs: Date.now() - started,
      packed: packed.identity,
      workerUrl: expectedWorker,
      searchClient: "createSearchClient",
      worker: "searchWorkerUrl()/searchWorker.js",
      retrievers: {
        historical: "full-scan",
        indexedSmoke: ["recurse", "sharde", "frames per", ...EXPANSION_CONTRACTS.map((spec) => spec.query)],
      },
      fixture: {
        dir: "test/fixtures/software-land",
        documentCount: inputs.documents.length,
        historicalRows: inputs.historical.rows.length,
        applicable: applicable.length,
        obsoleteC: obsolete.map((row) => row.query),
        uniqueExactQueries: uniqueExact.size,
        uniqueNormalizedQueries: uniqueNormalized.size,
      },
      historical: {
        applicable: applicable.length,
        passing: evaluations.filter((row) => row.ok).length,
        failed: evaluations.filter((row) => !row.ok).length,
        assertions: applicable.length,
      },
      v2Contracts: {
        browser: "open, oauth, and open authorization run on the frozen corpus; document-overlay contracts from v2-contracts.json run in one packed Worker session per retriever",
        documentOverlay: documentOverlayResults,
      },
      controls: Object.fromEntries(
        CRITICAL_CONTROLS.map((query) => [
          query,
          {
            titles: (controls[query]?.titles || []).slice(0, 8),
            ids: (controls[query]?.ids || []).slice(0, 8),
            directClass: (controls[query]?.directClass || []).slice(0, 3),
            relevanceKind: (controls[query]?.relevanceKind || []).slice(0, 3),
          },
        ])
      ),
      adjudicated: {
        recurse: recurseTitles,
        sharde: shardeTitles,
        framesPer: {
          primary: frames?.titles?.[0] || null,
          directClass: frames?.directClass?.[0] || null,
        },
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
