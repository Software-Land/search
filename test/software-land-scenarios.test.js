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

function writeInputs(dir) {
  writeFileSync(path.join(dir, "scenarios.js"), "export const scenarios = [];\n");
  writeFileSync(path.join(dir, "contracts.js"), "export const SEARCH_V2_CONTRACTS = [];\n");
}

function generate(dir) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--scenarios",
      path.join(dir, "scenarios.js"),
      "--contracts",
      path.join(dir, "contracts.js"),
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
    writeFileSync(
      path.join(dir, "regression-scenarios.json"),
      `${JSON.stringify({ overlayCases: OVERLAY })}\n`
    );
    const result = generate(dir);
    expect(result.status).toBe(0);
    const regressions = JSON.parse(readFileSync(path.join(dir, "regression-scenarios.json"), "utf8"));
    expect(regressions.overlayCases).toEqual(OVERLAY);
    expect(regressions.counts.overlayCases).toBe(1);
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
