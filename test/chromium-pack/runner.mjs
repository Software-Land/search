#!/usr/bin/env node
/**
 * Packed-package Chromium Worker integration.
 * Packs the repo, installs the tarball in a temp consumer, serves it over HTTP,
 * and drives a real module Worker via Playwright.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(harnessDir, "..", "..");
const WAIT_MS = 20_000;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function mimeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return null;
}

function safeFile(root, urlPath) {
  const raw = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, rel);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

function resolveBrowserImport(pkg) {
  const exp = pkg.exports?.["./browser"];
  if (!exp || typeof exp !== "object" || !exp.import) {
    throw new Error(`installed package missing exports["./browser"].import: ${JSON.stringify(pkg.exports)}`);
  }
  const rel = String(exp.import).replace(/^\.\//, "");
  return {
    rel,
    href: `/node_modules/@software-land/search/${rel}`,
    workerHref: `/node_modules/@software-land/search/${rel.replace(/[^/]+$/, "searchWorker.js")}`,
  };
}

function startServer(root) {
  const server = http.createServer((req, res) => {
    const filePath = safeFile(root, req.url || "/");
    if (!filePath) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const mime = mimeFor(filePath);
    if (!mime) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "search-chromium-pack-"));
  const packDir = path.join(tmp, "pack");
  const consumer = path.join(tmp, "consumer");
  let server;
  let browser;
  const diagnostics = [];
  try {
    run("npm", ["run", "build"], repoRoot);
    mkdirSync(packDir, { recursive: true });
    run("npm", ["pack", "--pack-destination", packDir], repoRoot);
    const tarballName = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    if (!tarballName) throw new Error("npm pack produced no tarball");
    const tarball = path.join(packDir, tarballName);

    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "search-chromium-pack-consumer", private: true, type: "module" }, null, 2)}\n`
    );
    run("npm", ["install", "--omit=dev", tarball], consumer);

    const installedPkgPath = path.join(consumer, "node_modules/@software-land/search/package.json");
    if (!existsSync(installedPkgPath)) throw new Error("tarball install missing @software-land/search");
    const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
    const browserExport = resolveBrowserImport(installedPkg);
    const browserFile = path.join(consumer, "node_modules/@software-land/search", browserExport.rel);
    if (!existsSync(browserFile)) {
      throw new Error(`resolved browser export missing on disk: ${browserExport.rel}`);
    }

    const importMap = {
      imports: {
        "@software-land/search/browser": browserExport.href,
      },
    };
    writeFileSync(
      path.join(consumer, "index.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>chromium-pack worker fixture</title>
    <script type="importmap">${JSON.stringify(importMap)}</script>
  </head>
  <body>
    <script type="module" src="/app.mjs"></script>
  </body>
</html>
`
    );
    copyFileSync(path.join(harnessDir, "app.mjs"), path.join(consumer, "app.mjs"));

    const started = await startServer(consumer);
    server = started.server;
    const origin = started.origin;

    browser = await chromium.launch({ headless: true });
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

    copyFileSync(path.join(harnessDir, "rank-bench-app.mjs"), path.join(consumer, "rank-bench-app.mjs"));
    writeFileSync(
      path.join(consumer, "rank.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>chromium-pack rank bench</title>
    <script type="importmap">${JSON.stringify(importMap)}</script>
  </head>
  <body>
    <script type="module" src="/rank-bench-app.mjs"></script>
  </body>
</html>
`
    );

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
    writeFileSync(
      path.join(consumer, "retrieval.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>chromium-pack retrieval bench</title>
    <script type="importmap">${JSON.stringify(importMap)}</script>
  </head>
  <body>
    <script type="module" src="/retrieval-bench-app.mjs"></script>
  </body>
</html>
`
    );

    const RETRIEVAL_WAIT_MS = 120_000;
    const retrievalPage = await browser.newPage();
    const retrievalConsoleErrors = [];
    retrievalPage.on("console", (msg) => {
      if (msg.type() === "error") retrievalConsoleErrors.push(msg.text());
    });
    await retrievalPage.goto(`${origin}/retrieval.html`, { waitUntil: "load", timeout: RETRIEVAL_WAIT_MS });
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
    if (retrievalBoot.results.length !== 6) {
      throw new Error(`retrieval-bench expected 6 rows, got ${JSON.stringify(retrievalBoot.results)}`);
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
