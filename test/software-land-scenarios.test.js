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

  test("overlay-owned queries are omitted from historical and V2 mining", () => {
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
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(historical.rows.map((row) => row.query)).toEqual(["kept", "kept-a"]);
    expect(historical.counts.rows).toBe(2);
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
