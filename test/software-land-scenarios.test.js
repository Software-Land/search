/**
 * Overlay preservation for scripts/software-land-scenarios.mjs.
 * Missing regression files are empty; malformed files must not drop overlays.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "software-land-scenarios.mjs");
const OVERLAY = [
  {
    query: "overlay-probe",
    kind: "regression",
    origin: "overlay",
    exactFirst: "Probe Title",
  },
];

function overlayCase(query) {
  return {
    query,
    kind: "regression",
    origin: "overlay",
    exactFirst: "Probe Title",
  };
}

function aClass(query, title) {
  return {
    query,
    classification: "A",
    intent: {
      requiredPrimary: [title],
      requiredWithin: [{ title, topN: 1 }],
      requiredAnyWithin: [],
    },
    v1: { expectedTop: [title], topN: 1 },
  };
}

function bClass(query, title) {
  return {
    query,
    classification: "B",
    intent: {
      requiredPrimary: [title],
      requiredWithin: [{ title, topN: 1 }],
      requiredAnyWithin: [],
    },
    v1: { expectedTop: [title], topN: 1 },
  };
}

function writeScenarios(dir, scenarios) {
  writeFileSync(path.join(dir, "scenarios.mjs"), `export const scenarios = ${JSON.stringify(scenarios, null, 2)};\n`);
}

function writeOverlay(dir, overlays) {
  writeFileSync(path.join(dir, "regression-scenarios.json"), `${JSON.stringify({ overlayCases: overlays })}\n`);
}

function writeContracts(dir, contracts) {
  writeFileSync(
    path.join(dir, "contracts.mjs"),
    `export const SEARCH_V2_CONTRACTS = ${JSON.stringify(contracts, null, 2)};\n`
  );
}

function writeInputs(dir) {
  writeFileSync(path.join(dir, "scenarios.mjs"), "export const scenarios = [];\n");
  writeFileSync(path.join(dir, "contracts.mjs"), "export const SEARCH_V2_CONTRACTS = [];\n");
}

function generate(dir) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--scenarios",
      path.join(dir, "scenarios.mjs"),
      "--contracts",
      path.join(dir, "contracts.mjs"),
      "--dir",
      dir,
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
}

describe("software-land-scenarios overlay preservation", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "software-land-scenarios-"));
    writeInputs(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing regression-scenarios.json is tolerated and yields no overlays", () => {
    const result = generate(dir);
    expect(result.status).toBe(0);
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    expect(regressions.overlayCases).toBeUndefined();
    expect(regressions.counts.overlayCases).toBeUndefined();
  });

  test("valid existing overlayCases are preserved", () => {
    writeOverlay(dir, OVERLAY);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    expect(regressions.overlayCases).toEqual(OVERLAY);
    expect(regressions.counts.overlayCases).toBe(1);
  });

  test("supplementary overlays stay in historical while mined V2 skips the overlay query", () => {
    writeScenarios(dir, [
      aClass("overlay-probe", "Probe Title"),
      {
        query: "kept",
        classification: "B",
        intent: { requiredPrimary: [], requiredWithin: [], requiredAnyWithin: [] },
        v1: { expectedTop: ["Kept Title"], topN: 1 },
      },
      aClass("kept-a", "Kept A Title"),
    ]);
    writeOverlay(dir, OVERLAY);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    const contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(index.counts.sourceScenarioRows).toBe(3);
    expect(index.counts.omittedOverlayOwned).toBe(0);
    expect(historical.rows.map((row) => row.query)).toEqual(["overlay-probe", "kept", "kept-a"]);
    expect(historical.counts.rows).toBe(3);
    expect(contracts.cases.map((row) => row.query)).toEqual(["kept-a"]);
    expect(contracts.cases[0].exactFirst).toBe("Kept A Title");
  });

  test("overlay identity is exact query equality after trim only", () => {
    writeScenarios(dir, [
      aClass("integ", "Integrity Is Not Obedience"),
      aClass("Integ", "Case Title"),
      aClass("integ extra", "Extra Title"),
    ]);
    writeOverlay(dir, [overlayCase("integ")]);
    let result = generate(dir);
    expect(result.status).toBe(0);
    let historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    let contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    let index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(historical.rows.map((row) => row.query)).toEqual(["Integ", "integ extra"]);
    expect(contracts.cases.map((row) => row.query)).toEqual(["Integ", "integ extra"]);

    writeOverlay(dir, [overlayCase("integ ")]);
    result = generate(dir);
    expect(result.status).toBe(0);
    historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(historical.rows.map((row) => row.query)).toEqual(["Integ", "integ extra"]);
    expect(contracts.cases.map((row) => row.query)).toEqual(["Integ", "integ extra"]);
  });

  test("overlay with no source overlap is preserved and does not increment omittedOverlayOwned", () => {
    writeScenarios(dir, [aClass("kept-a", "Kept A Title")]);
    writeOverlay(dir, [overlayCase("integ")]);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    const contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(index.counts.sourceScenarioRows).toBe(1);
    expect(index.counts.omittedOverlayOwned).toBe(0);
    expect(historical.rows.map((row) => row.query)).toEqual(["kept-a"]);
    expect(contracts.cases.map((row) => row.query)).toEqual(["kept-a"]);
    expect(regressions.overlayCases).toEqual([overlayCase("integ")]);
    expect(regressions.counts.overlayCases).toBe(1);
  });

  test("supplementary open overlay keeps the obsolete historical row and integ stays excluded", () => {
    writeScenarios(dir, [
      {
        query: "open",
        classification: "C",
        intent: { requiredPrimary: [], requiredWithin: [], requiredAnyWithin: [] },
        v1: { expectedTop: ["SAML vs OAuth"], topN: 1 },
      },
      aClass("integ", "Old Integrity Title"),
      aClass("kept-a", "Kept A Title"),
    ]);
    writeContracts(dir, [
      { query: "open", requiredAnyTop: { titles: ["SAML vs OAuth"], topN: 10 } },
      { query: "oauth", requiredPrimary: "SAML vs OAuth" },
      { query: "open authorization", requiredPrimary: "SAML vs OAuth" },
    ]);
    writeOverlay(dir, [
      overlayCase("integ"),
      {
        query: "open",
        kind: "regression",
        origin: "overlay",
        requiredWithin: [{ id: "7", title: "SAML vs OAuth", topN: 10 }],
      },
      overlayCase("oauth"),
      overlayCase("open authorization"),
    ]);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    const contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(historical.rows.map((row) => row.query)).toEqual(["open", "kept-a"]);
    expect(historical.rows.find((row) => row.query === "open")).toMatchObject({
      classification: "C",
      disposition: "omitted-obsolete",
    });
    expect(contracts.cases.map((row) => row.query)).toEqual([
      "kept-a",
      "open",
      "oauth",
      "open authorization",
    ]);
    expect(regressions.overlayCases.map((row) => row.query)).toEqual([
      "integ",
      "open",
      "oauth",
      "open authorization",
    ]);
    expect(index.counts.historicalRows).toBe(2);
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(index.counts.executableContracts).toBe(4);
  });

  test("scenario replay keeps the accepted what-are-apis regression and the direct TLS relationship", () => {
    writeScenarios(dir, [
      {
        query: "what are apis",
        classification: "B",
        intent: {
          requiredPrimary: ["Working with APIs"],
          requiredWithin: [{ title: "Working with APIs", topN: 1 }],
          requiredAnyWithin: [],
        },
        v1: { expectedTop: ["Working with APIs"], topN: 5 },
      },
    ]);
    writeContracts(dir, [{ query: "tls", requiredPrimary: "TLS 1.2 Vulnerability" }]);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    expect(regressions.cases[0]).toMatchObject({
      query: "what are apis",
      exactFirst: "What is an API?",
      requiredWithin: [
        { title: "What is an API?", topN: 1 },
        { title: "Working with APIs", topN: 2 },
        { title: "REST API vs GraphQL", topN: 3 },
      ],
    });
    const contracts = JSON.parse(readFileSync(path.join(dir, "v2-contracts.json"), "utf8"));
    expect(contracts.cases[0].relationship).toMatchObject({
      title: "What is VPN?",
      relevanceKind: "direct",
      sourceTitle: "TLS 1.2 Vulnerability",
    });
  });

  test("overlay-owned B-class queries are omitted from regression mining", () => {
    writeScenarios(dir, [
      bClass("integ", "Integrity Is Not Obedience"),
      bClass("other-b", "Other B Title"),
    ]);
    writeOverlay(dir, [overlayCase("integ")]);
    const result = generate(dir);
    expect(result.status).toBe(0);
    const historical = JSON.parse(readFileSync(path.join(dir, "historical-scenarios.json"), "utf8"));
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    const index = JSON.parse(readFileSync(path.join(dir, "scenarios.json"), "utf8"));
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(historical.rows.map((row) => row.query)).toEqual(["other-b"]);
    expect(regressions.cases.map((row) => row.query)).toEqual(["other-b"]);
    expect(regressions.overlayCases).toEqual([overlayCase("integ")]);
  });

  test("malformed regression-scenarios.json fails instead of dropping overlays", () => {
    const broken = path.join(dir, "regression-scenarios.json");
    writeFileSync(broken, "{");
    const result = generate(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/JSON|SyntaxError|Unexpected/i);
    expect(readFileSync(broken, "utf8")).toBe("{");
  });

  test("non-array overlayCases fails and leaves the original file untouched", () => {
    const regressions = path.join(dir, "regression-scenarios.json");
    const raw = `${JSON.stringify({ overlayCases: { query: "overlay-probe" } })}\n`;
    writeFileSync(regressions, raw);
    const result = generate(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/overlayCases must be an array/);
    expect(readFileSync(regressions, "utf8")).toBe(raw);
  });
});
