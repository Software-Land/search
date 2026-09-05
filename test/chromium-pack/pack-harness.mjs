/**
 * Shared packed-tarball Chromium consumer setup.
 * Honors SEARCH_PACK_TGZ (skip rebuild/repack) and SEARCH_SKIP_BUILD.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertAuthoredRelevanceContract } from "./authored-relevance-contract.mjs";

export const harnessDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(harnessDir, "..", "..");
export const WAIT_MS = 20_000;
export const CORPUS_BOOT_MS = 120_000;
export const CORPUS_QUERY_MS = 30_000;

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export function mimeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return null;
}

export function safeFile(root, urlPath) {
  const raw = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, rel);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

export function resolveBrowserImport(pkg) {
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

export function hashFile(filePath, algo = "sha256") {
  return createHash(algo).update(readFileSync(filePath)).digest("hex");
}

export function describePackedTarball(tarball, installedPkgPath) {
  const buf = readFileSync(tarball);
  const pkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
  const installedRoot = path.dirname(installedPkgPath);
  const browserRel = String(pkg.exports?.["./browser"]?.import || "").replace(/^\.\//, "");
  const distIndex = path.join(installedRoot, "dist", "index.js");
  const browserEntry = path.join(installedRoot, browserRel);
  const workerEntry = path.join(installedRoot, browserRel.replace(/[^/]+$/, "searchWorker.js"));
  return {
    name: pkg.name,
    version: pkg.version,
    tarball: path.resolve(tarball),
    tarballBytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    npmShasum: createHash("sha1").update(buf).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(buf).digest("base64")}`,
    distIndexSha256: existsSync(distIndex) ? hashFile(distIndex) : null,
    browserEntry: pkg.exports?.["./browser"]?.import || null,
    browserEntrySha256: existsSync(browserEntry) ? hashFile(browserEntry) : null,
    searchWorkerSha256: existsSync(workerEntry) ? hashFile(workerEntry) : null,
  };
}

export function startServer(root) {
  const server = http.createServer((req, res) => {
    if (String(req.url || "").split("?")[0] === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
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
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    });
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

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

export function writeImportMapHtml(consumer, { filename, title, scriptSrc, importMap }) {
  writeFileSync(
    path.join(consumer, filename),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <script type="importmap">${JSON.stringify(importMap)}</script>
  </head>
  <body>
    <script type="module" src="${scriptSrc}"></script>
  </body>
</html>
`
  );
}

export function systemChromePath() {
  return [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

export async function launchChromium() {
  const systemChrome = systemChromePath();
  return chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--headless"],
    args: ["--headless=new", "--enable-precise-memory-info"],
    ...(systemChrome ? { executablePath: systemChrome } : {}),
  });
}

export function attachPageDiagnostics(page) {
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
    if (res.status() >= 400 && (url.endsWith(".js") || url.endsWith(".mjs") || url.includes("searchWorker") || url.endsWith(".json"))) {
      httpFailures.push(`${res.status()} ${url}`);
    }
  });
  page.on("worker", (worker) => {
    workers.push(worker.url());
    worker.on("close", () => {});
  });
  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    httpFailures,
    workers,
    assertClean(label) {
      if (pageErrors.length) throw new Error(`${label} pageerror: ${pageErrors.join("\n")}`);
      if (consoleErrors.length) throw new Error(`${label} console error: ${consoleErrors.join("\n")}`);
      if (failedRequests.length) throw new Error(`${label} request failed: ${failedRequests.join("\n")}`);
      if (httpFailures.length) throw new Error(`${label} module/Worker HTTP error: ${httpFailures.join("\n")}`);
    },
  };
}

export async function preparePackedConsumer(tmp) {
  const packDir = path.join(tmp, "pack");
  const consumer = path.join(tmp, "consumer");
  const envTarball = process.env.SEARCH_PACK_TGZ ? path.resolve(process.env.SEARCH_PACK_TGZ) : "";
  const skipBuild = process.env.SEARCH_SKIP_BUILD === "1" || Boolean(envTarball);

  if (!skipBuild) {
    run("npm", ["run", "build"], repoRoot);
  }

  let tarball = envTarball;
  if (tarball) {
    if (!existsSync(tarball) || !statSync(tarball).isFile()) {
      throw new Error(`SEARCH_PACK_TGZ is not a tarball file: ${tarball}`);
    }
  } else {
    mkdirSync(packDir, { recursive: true });
    run("npm", ["pack", "--pack-destination", packDir], repoRoot);
    const tarballName = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    if (!tarballName) throw new Error("npm pack produced no tarball");
    tarball = path.join(packDir, tarballName);
  }

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
  const lexicalSpec = installedPkg.exports?.["./lexical"];
  if (!lexicalSpec || typeof lexicalSpec !== "object" || !lexicalSpec.import) {
    throw new Error(`installed package missing exports["./lexical"].import: ${JSON.stringify(installedPkg.exports)}`);
  }
  const lexicalRel = String(lexicalSpec.import).replace(/^\.\//, "");
  const lexicalHref = `/node_modules/@software-land/search/${lexicalRel}`;
  const rootSpec = installedPkg.exports?.["."];
  if (!rootSpec || typeof rootSpec !== "object" || !rootSpec.import) {
    throw new Error(`installed package missing exports["."].import: ${JSON.stringify(installedPkg.exports)}`);
  }
  const rootRel = String(rootSpec.import).replace(/^\.\//, "");
  const rootHref = `/node_modules/@software-land/search/${rootRel}`;
  const browserFile = path.join(consumer, "node_modules/@software-land/search", browserExport.rel);
  if (!existsSync(browserFile)) {
    throw new Error(`resolved browser export missing on disk: ${browserExport.rel}`);
  }
  const workerFile = path.join(
    consumer,
    "node_modules/@software-land/search",
    browserExport.rel.replace(/[^/]+$/, "searchWorker.js")
  );
  if (!existsSync(workerFile)) {
    throw new Error(`packed searchWorker.js missing next to browser entry: ${workerFile}`);
  }
  const installedRoot = path.dirname(installedPkgPath);
  assertAuthoredRelevanceContract(
    {
      workerRuntime: readFileSync(path.join(installedRoot, "dist/browser/workerRuntime.js"), "utf8"),
      configuredConceptsModule: readFileSync(path.join(installedRoot, "dist/relationships/configuredConcepts.js"), "utf8"),
    },
    envTarball ? `SEARCH_PACK_TGZ=${tarball}` : `fresh pack ${tarball}`
  );

  const importMap = {
    imports: {
      "@software-land/search": rootHref,
      "@software-land/search/browser": browserExport.href,
      "@software-land/search/lexical": lexicalHref,
    },
  };

  return {
    consumer,
    tarball,
    installedPkg,
    installedPkgPath,
    installedRoot,
    browserExport,
    lexicalRel,
    importMap,
    identity: describePackedTarball(tarball, installedPkgPath),
  };
}
