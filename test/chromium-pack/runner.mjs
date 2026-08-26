#!/usr/bin/env node
/**
 * Packed-package Chromium Worker integration.
 * Packs the repo, installs the tarball in a temp consumer, serves it over HTTP,
 * and drives a real module Worker via Playwright.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WAIT_MS,
  closeServer,
  harnessDir,
  launchChromium,
  preparePackedConsumer,
  startServer,
  writeImportMapHtml,
} from "./pack-harness.mjs";

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "search-chromium-pack-"));
  let server;
  let browser;
  const diagnostics = [];
  try {
    const packed = await preparePackedConsumer(tmp);
    const { consumer, browserExport, importMap } = packed;
    writeImportMapHtml(consumer, {
      filename: "index.html",
      title: "chromium-pack worker fixture",
      scriptSrc: "/app.mjs",
      importMap,
    });
    copyFileSync(path.join(harnessDir, "app.mjs"), path.join(consumer, "app.mjs"));

    const started = await startServer(consumer);
    server = started.server;
    const origin = started.origin;

    browser = await launchChromium();
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const httpFailures = [];
    const workers = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(String(err?.stack || err?.message || err));
    });
    page.on("requestfailed", (req) => {
      const url = req.url();
      if (url.endsWith("/favicon.ico")) return;
      failedRequests.push(`${req.failure()?.errorText || "failed"} ${url}`);
    });
    page.on("response", (res) => {
      const url = res.url();
      if (url.endsWith("/favicon.ico")) return;
      if (res.status() >= 400 && (url.endsWith(".js") || url.endsWith(".mjs") || url.includes("searchWorker"))) {
        httpFailures.push(`${res.status()} ${url}`);
      }
    });
    page.on("worker", (worker) => {
      workers.push(worker.url());
      worker.on("close", () => {});
    });

    await page.goto(`${origin}/`, { waitUntil: "load", timeout: WAIT_MS });
    await page.waitForFunction(() => window.__booted === true || window.__bootError, null, { timeout: WAIT_MS });
    const boot = await page.evaluate(() => ({
      booted: window.__booted,
      bootError: window.__bootError || null,
      workerUrl: window.__state?.workerUrl || null,
      errors: window.__state?.errors || [],
    }));
    if (!boot.booted) {
      throw new Error(`Worker/page boot failed: ${boot.bootError || JSON.stringify(boot.errors)}`);
    }

    const workerUrl = boot.workerUrl;
    const expectedWorker = `${origin}${browserExport.workerHref}`;
    if (!workerUrl || !workerUrl.startsWith("http://127.0.0.1:")) {
      throw new Error(`searchWorkerUrl() did not resolve over HTTP: ${workerUrl}`);
    }
    if (!workerUrl.endsWith("/searchWorker.js")) {
      throw new Error(`searchWorkerUrl() must end with /searchWorker.js: ${workerUrl}`);
    }
    if (workerUrl !== expectedWorker) {
      throw new Error(`searchWorkerUrl() was ${workerUrl}, expected packed sibling ${expectedWorker}`);
    }
    if (!workers.includes(expectedWorker)) {
      throw new Error(`expected packed Worker ${expectedWorker}, observed ${JSON.stringify(workers)}`);
    }

    await page.evaluate(() => window.__runNormalSearch());
    await page.waitForFunction(
      () => {
        const s = window.__state;
        if (s.errors.length) return true;
        return s.published.some((row) => row.query === "nfc" && row.generation === s.normalGeneration);
      },
      null,
      { timeout: WAIT_MS }
    );
    const afterNormal = await page.evaluate(() => window.__state);
    if (afterNormal.errors.length) {
      throw new Error(`client/page errors after normal search: ${JSON.stringify(afterNormal.errors)}`);
    }
    const normalHit = afterNormal.published.find(
      (row) => row.query === "nfc" && row.generation === afterNormal.normalGeneration
    );
    if (!normalHit || normalHit.ids[0] !== "nfc") {
      throw new Error(`normal search expected top id nfc, got ${JSON.stringify(afterNormal.published)}`);
    }

    const beforeLatest = afterNormal.published.length;
    await page.evaluate(() => window.__runLatestWins());
    await page.waitForFunction(
      () => {
        const s = window.__state;
        if (s.errors.length) return true;
        const last = s.published[s.published.length - 1];
        return Boolean(last && last.query === "nfc" && last.generation === s.latestWinsGeneration);
      },
      null,
      { timeout: WAIT_MS }
    );
    const afterLatest = await page.evaluate(() => window.__state);
    if (afterLatest.errors.length) {
      throw new Error(`client/page errors after latest-wins: ${JSON.stringify(afterLatest.errors)}`);
    }
    const last = afterLatest.published[afterLatest.published.length - 1];
    if (last.query !== "nfc" || last.generation !== afterLatest.latestWinsGeneration || last.ids[0] !== "nfc") {
      throw new Error(`latest-wins final publish must be nfc, got ${JSON.stringify(afterLatest.published.slice(beforeLatest))}`);
    }
    const afterFinal = afterLatest.published.slice(
      afterLatest.published.findIndex(
        (row) => row.query === "nfc" && row.generation === afterLatest.latestWinsGeneration
      ) + 1
    );
    if (afterFinal.some((row) => row.generation < afterLatest.latestWinsGeneration)) {
      throw new Error(`older result replaced latest nfc publish: ${JSON.stringify(afterFinal)}`);
    }

    if (pageErrors.length) throw new Error(`pageerror: ${pageErrors.join("\n")}`);
    if (consoleErrors.length) throw new Error(`console error: ${consoleErrors.join("\n")}`);
    if (failedRequests.length) throw new Error(`request failed: ${failedRequests.join("\n")}`);
    if (httpFailures.length) throw new Error(`module/Worker HTTP error: ${httpFailures.join("\n")}`);

    await page.evaluate(() => window.__dispose());

    copyFileSync(path.join(harnessDir, "relationship-app.mjs"), path.join(consumer, "relationship-app.mjs"));
    writeImportMapHtml(consumer, {
      filename: "relationship.html",
      title: "chromium-pack relationshipMap worker",
      scriptSrc: "/relationship-app.mjs",
      importMap,
    });

    const relationshipPage = await browser.newPage();
    const relationshipConsoleErrors = [];
    const relationshipPageErrors = [];
    relationshipPage.on("console", (msg) => {
      if (msg.type() === "error") relationshipConsoleErrors.push(msg.text());
    });
    relationshipPage.on("pageerror", (err) => {
      relationshipPageErrors.push(String(err?.stack || err?.message || err));
    });
    await relationshipPage.goto(`${origin}/relationship.html`, { waitUntil: "load", timeout: WAIT_MS });
    await relationshipPage.waitForFunction(() => window.__booted === true || window.__bootError, null, {
      timeout: WAIT_MS,
    });
    const relationshipBoot = await relationshipPage.evaluate(() => ({
      booted: window.__booted,
      bootError: window.__bootError || null,
      errors: window.__state?.errors || [],
      workerUrl: window.__state?.workerUrl || null,
    }));
    if (!relationshipBoot.booted) {
      throw new Error(`relationshipMap boot failed: ${relationshipBoot.bootError || JSON.stringify(relationshipBoot.errors)}`);
    }
    if (relationshipBoot.errors.length) {
      throw new Error(`relationshipMap init errors: ${JSON.stringify(relationshipBoot.errors)}`);
    }
    const relationshipQueries = [
      { query: "qa", options: { limit: 10, relatedLimit: 8, explain: true } },
      { query: "hypertext", options: { limit: 10, relatedLimit: 8, explain: true } },
      { query: "appsec", options: { limit: 10, relatedLimit: 8, explain: true } },
      {
        query: "krypton primary",
        options: { limit: 10, relatedLimit: 8, explain: true, relationshipStrategy: "separate" },
      },
    ];
    for (const row of relationshipQueries) {
      const before = await relationshipPage.evaluate(() => window.__state.published.length);
      await relationshipPage.evaluate(
        ({ query, options }) => window.__runQuery(query, options),
        row
      );
      await relationshipPage.waitForFunction(
        ({ query, beforeCount }) => {
          const s = window.__state;
          if (s.errors.length) return true;
          return s.published.length > beforeCount && s.published[s.published.length - 1].query === query;
        },
        { query: row.query, beforeCount: before },
        { timeout: WAIT_MS }
      );
    }
    const relationshipState = await relationshipPage.evaluate(() => window.__state);
    if (relationshipState.errors.length) {
      throw new Error(`relationshipMap search errors: ${JSON.stringify(relationshipState.errors)}`);
    }
    const lastByQuery = Object.fromEntries(
      ["qa", "hypertext", "appsec", "krypton primary"].map((query) => {
        const rows = relationshipState.published.filter((row) => row.query === query);
        return [query, rows[rows.length - 1]];
      })
    );
    if (!lastByQuery.qa?.ids?.includes("testing")) {
      throw new Error(`relationshipMap synonym missing testing: ${JSON.stringify(lastByQuery.qa)}`);
    }
    if (lastByQuery.hypertext?.ids?.[0] !== "http-doc") {
      throw new Error(`relationshipMap standalone missing http-doc: ${JSON.stringify(lastByQuery.hypertext)}`);
    }
    if (lastByQuery.appsec?.ids?.[0] !== "authn") {
      throw new Error(`relationshipMap topical missing authn: ${JSON.stringify(lastByQuery.appsec)}`);
    }
    if (!lastByQuery["krypton primary"]?.relatedIds?.includes("doc-b")) {
      throw new Error(`relationshipMap editorial missing doc-b: ${JSON.stringify(lastByQuery["krypton primary"])}`);
    }
    if (relationshipPageErrors.length) throw new Error(`relationshipMap pageerror: ${relationshipPageErrors.join("\n")}`);
    if (relationshipConsoleErrors.length) {
      throw new Error(`relationshipMap console error: ${relationshipConsoleErrors.join("\n")}`);
    }
    await relationshipPage.evaluate(() => window.__dispose());

    copyFileSync(path.join(harnessDir, "rank-bench-app.mjs"), path.join(consumer, "rank-bench-app.mjs"));
    writeImportMapHtml(consumer, {
      filename: "rank.html",
      title: "chromium-pack rank bench",
      scriptSrc: "/rank-bench-app.mjs",
      importMap,
    });

    const RANK_WAIT_MS = 60_000;
    const rankPage = await browser.newPage();
    const rankConsoleErrors = [];
    rankPage.on("console", (msg) => {
      if (msg.type() === "error") rankConsoleErrors.push(msg.text());
    });
    await rankPage.goto(`${origin}/rank.html`, { waitUntil: "load", timeout: RANK_WAIT_MS });
    await rankPage.waitForFunction(() => window.__booted === true || window.__bootError, null, {
      timeout: RANK_WAIT_MS,
    });
    const rankBoot = await rankPage.evaluate(() => ({
      booted: window.__booted,
      bootError: window.__bootError || null,
      errors: window.__state?.errors || [],
      results: window.__state?.results || [],
      workerUrl: window.__state?.workerUrl || null,
    }));
    if (!rankBoot.booted) {
      throw new Error(`rank-bench boot failed: ${rankBoot.bootError || JSON.stringify(rankBoot.errors)}`);
    }
    if (rankBoot.errors.length) {
      throw new Error(`rank-bench errors: ${JSON.stringify(rankBoot.errors)}`);
    }
    if (rankConsoleErrors.length) throw new Error(`rank-bench console error: ${rankConsoleErrors.join("\n")}`);
    for (const row of rankBoot.results) {
      if (row.candidateCount !== 1000) {
        throw new Error(`rank-bench ${row.workload} expected C=1000, got ${JSON.stringify(row)}`);
      }
    }

    copyFileSync(path.join(harnessDir, "retrieval-bench-app.mjs"), path.join(consumer, "retrieval-bench-app.mjs"));
    writeImportMapHtml(consumer, {
      filename: "retrieval.html",
      title: "chromium-pack retrieval bench",
      scriptSrc: "/retrieval-bench-app.mjs",
      importMap,
    });

    const retrievalSizes = String(process.env.SEARCH_RETRIEVAL_SIZES || "1000,2000,5000")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const measureBrowserMemory = process.env.SEARCH_MEASURE_BROWSER_MEMORY === "1";
    const RETRIEVAL_WAIT_MS = measureBrowserMemory ? 360_000 : 180_000;
    const retrievalPage = await browser.newPage();
    const retrievalConsoleErrors = [];
    retrievalPage.on("console", (msg) => {
      if (msg.type() === "error") retrievalConsoleErrors.push(msg.text());
    });
    const retrievalQuery = new URLSearchParams({
      sizes: retrievalSizes.join(","),
      ...(measureBrowserMemory ? { memory: "1" } : {}),
    });
    await retrievalPage.goto(`${origin}/retrieval.html?${retrievalQuery}`, {
      waitUntil: "load",
      timeout: RETRIEVAL_WAIT_MS,
    });
    await retrievalPage.waitForFunction(() => window.__booted === true || window.__bootError, null, {
      timeout: RETRIEVAL_WAIT_MS,
    });
    const retrievalBoot = await retrievalPage.evaluate(() => ({
      booted: window.__booted,
      bootError: window.__bootError || null,
      errors: window.__state?.errors || [],
      results: window.__state?.results || [],
    }));
    if (!retrievalBoot.booted) {
      throw new Error(`retrieval-bench boot failed: ${retrievalBoot.bootError || JSON.stringify(retrievalBoot.errors)}`);
    }
    if (retrievalBoot.errors.length) {
      throw new Error(`retrieval-bench errors: ${JSON.stringify(retrievalBoot.errors)}`);
    }
    if (retrievalConsoleErrors.length) throw new Error(`retrieval-bench console error: ${retrievalConsoleErrors.join("\n")}`);
    const expectedRetrievalRows = retrievalSizes.length * 4 * 6;
    if (retrievalBoot.results.length !== expectedRetrievalRows) {
      throw new Error(
        `retrieval-bench expected ${expectedRetrievalRows} rows, got ${JSON.stringify(retrievalBoot.results)}`
      );
    }
    for (const n of retrievalSizes) {
      for (const queryFamily of [
        "rare-exact",
        "high-df",
        "adversarial-short-literal",
        "adversarial-independent-title-token",
        "software-land-machine-prefix",
        "phrase",
      ]) {
        const rows = retrievalBoot.results.filter((row) => row.n === n && row.queryFamily === queryFamily);
        const full = rows.find((row) => row.mode === "full-scan");
        if (!full || rows.some((row) => row.topId !== full.topId)) {
          throw new Error(`retrieval-bench exact-output mismatch: ${JSON.stringify({ n, queryFamily, rows })}`);
        }
        const indexed = rows.filter((row) =>
          row.mode === "indexed-fallback" ||
          row.mode === "indexed-precompiled" ||
          row.mode === "indexed-precompiled-exhaustive"
        );
        if (indexed.some((row) => row.rawDocumentScans !== 0)) {
          throw new Error(`retrieval-bench indexed path scanned raw documents: ${JSON.stringify({ n, queryFamily, rows })}`);
        }
      }
    }

    diagnostics.push({
      origin,
      workerUrl,
      expectedWorker,
      browserExport: browserExport.href,
      workers,
      normalIds: normalHit.ids,
      latestWinsPublished: afterLatest.published.slice(beforeLatest),
      latestWinsFinal: last,
      relationshipMap: lastByQuery,
      rankBench: rankBoot.results,
      retrievalBench: retrievalBoot.results,
    });
    console.log(JSON.stringify({ ok: true, ...diagnostics[0] }, null, 2));
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
