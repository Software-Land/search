import { assertExplainedShardeControl, assertExportedScenario } from "./helpers/scenario-assertions.js";
import { loadSoftwareLandJson } from "./helpers/software-land-fixture.js";

const LINEAR = "Linear vs Logistic Regression";
const LINKEDIN = "LinkedIn Learning Review";
const FENWICK = "Fenwick Tree";
const STAYING = "Staying Ahead of the AI Revolution";
const CONVERSION = "LLM Model Conversion Correctness";
const LLAMA = "Working with Llama.cpp Embeddings";

function hits(titles) {
  return titles.map((title, index) => ({ title, id: `id-${index}` }));
}

test("LinkedIn above Linear fails the machine-learning comparison", () => {
  expect(() => assertExportedScenario(hits([LINKEDIN, LINEAR]), {
    query: "machine learn",
    requiredAnyTop: { titles: [LINEAR], topN: 10 },
    mustNotDominate: { primary: LINEAR, titles: [LINKEDIN] },
  })).toThrow(/LinkedIn Learning Review must not dominate Linear vs Logistic Regression/);
});

test("Linear above LinkedIn satisfies the comparison without being first", () => {
  expect(() => assertExportedScenario(hits(["Working with Llama.cpp Embeddings", LINEAR, LINKEDIN]), {
    query: "machine learning",
    requiredAnyTop: { titles: [LINEAR], topN: 10 },
    mustNotDominate: { primary: LINEAR, titles: [LINKEDIN] },
  })).not.toThrow();
});

test("Fenwick inside the AI window fails the exclusion", () => {
  expect(() => assertExportedScenario(hits([STAYING, FENWICK, CONVERSION, LLAMA]), {
    query: "ai",
    exactFirst: STAYING,
    requiredAnyTop: { titles: [CONVERSION, LLAMA], topN: 10 },
    absentWithin: { titles: [FENWICK], topN: 10 },
  })).toThrow(/Fenwick Tree must stay outside the top 10/);
});

test("a missing required article fails", () => {
  expect(() => assertExportedScenario(hits([STAYING]), {
    query: "machine learn",
    requiredAnyTop: { titles: [LINEAR], topN: 10 },
  })).toThrow(/Missing required article "Linear vs Logistic Regression"/);
});

test("dominance titles without a comparison target are rejected", () => {
  expect(() => assertExportedScenario(hits([LINEAR]), {
    query: "machine learn",
    mustNotDominate: { titles: [LINKEDIN] },
  })).toThrow(/mustNotDominate\.primary is required/);
});

test("unsupported assertion fields are rejected", () => {
  expect(() => assertExportedScenario(hits([LINEAR]), {
    query: "machine learn",
    requiredAnyTop: { titles: [LINEAR], topN: 10 },
    links: [{ title: LINEAR, href: "/blog/linear-vs-logistic-regression/" }],
  })).toThrow(/Unsupported assertion field "links"/);
});

test("Zero-Trust precedes Llama only when Llama is also visible", () => {
  const ZERO = "Zero-Trust Security";
  const row = {
    query: "appsec",
    exactFirst: "App Sec",
    requiredAnyTop: {
      titles: ["RBAC (Role Based Access Control)", "Authorization Middleware"],
      topN: 10,
    },
    requiredWithin: [{ title: ZERO, topN: 3 }],
    precedes: [{ earlier: ZERO, later: LLAMA, topN: 10, whenLaterVisible: true }],
  };
  expect(() => assertExportedScenario(hits([
    "App Sec",
    LLAMA,
    ZERO,
    "RBAC (Role Based Access Control)",
    "Authorization Middleware",
  ]), row)).toThrow(/Zero-Trust Security must precede Working with Llama.cpp Embeddings/);
  expect(() => assertExportedScenario(hits([
    "App Sec",
    "RBAC (Role Based Access Control)",
    "SAML vs OAuth",
    ZERO,
    "Authorization Middleware",
  ]), row)).toThrow(/Missing required article "Zero-Trust Security" within the top 3/);
  expect(() => assertExportedScenario(hits([
    "App Sec",
    ZERO,
    "SAML vs OAuth",
    "RBAC (Role Based Access Control)",
    "Authorization Middleware",
    LLAMA,
  ]), row)).not.toThrow();
  expect(() => assertExportedScenario(hits([
    "App Sec",
    ZERO,
    "RBAC (Role Based Access Control)",
    "Authorization Middleware",
  ]), row)).not.toThrow();
});

test("an assertion-free label is not executable coverage", () => {
  expect(() => assertExportedScenario([], { query: "recent search transitions" })).toThrow(
    /not executable coverage/
  );
});

test("explained sharde accepts membership-bag order and rejects contract violations", () => {
  const historicalRows = loadSoftwareLandJson("historical-scenarios.json").rows;
  const strictCases = loadSoftwareLandJson("strict-contracts.json").cases;
  const row136 = historicalRows.find((row) => row.index === 136 && row.query === "sharde");
  const row140 = historicalRows.find((row) => row.index === 140 && row.query === "sharde");
  const strict = strictCases.find((row) => row.query === "sharde" && row.origin === "scenario");
  expect(row136?.v1?.expectedTop).toEqual(expect.arrayContaining(["LLM Model Conversion Correctness"]));
  expect(row140?.v1?.topN).toBe(6);
  expect(row140?.v1?.expectedTop).toHaveLength(6);
  expect(row140?.v1?.expectedTop).toEqual(expect.arrayContaining([
    "Sharding",
    "Hot Shards",
    "LLM Model Conversion Correctness",
    "Throughput vs Latency",
  ]));
  expect(strict?.exactFirst).toBe("Sharding");
  expect(strict?.requiredWithin).toEqual(expect.arrayContaining([
    { title: "Sharding", topN: 1 },
    { title: "Hot Shards", topN: 2 },
    { title: "Throughput vs Latency", topN: 10 },
  ]));

  const bag = row140.v1.expectedTop;
  const rest = bag.filter((title) => title !== "Sharding" && title !== "Hot Shards");
  const shown = (titles) => ({
    titles,
    ids: titles.map((title, index) => `${title}:${index}`),
  });
  const forward = ["Sharding", "Hot Shards", ...rest];
  const reversed = ["Sharding", "Hot Shards", ...rest.slice().reverse()];
  expect(forward).not.toEqual(reversed);
  expect(() => assertExplainedShardeControl(shown(forward), historicalRows, strictCases)).not.toThrow();
  expect(() => assertExplainedShardeControl(shown(reversed), historicalRows, strictCases)).not.toThrow();

  const withoutConversion = forward.filter((title) => title !== "LLM Model Conversion Correctness");
  expect(() => assertExplainedShardeControl(shown(withoutConversion), historicalRows, strictCases)).toThrow(
    /LLM Model Conversion Correctness/
  );

  const withoutThroughput = bag.filter((title) => title !== "Throughput vs Latency");
  const throughputAtSeven = [...withoutThroughput, "Vertical vs Horizontal Scaling", "Throughput vs Latency"];
  expect(() => assertExportedScenario(
    throughputAtSeven.map((title, index) => ({ title, id: `late-${index}` })),
    strict
  )).not.toThrow();
  expect(() => assertExplainedShardeControl(shown(throughputAtSeven), historicalRows, strictCases)).toThrow(
    /Throughput vs Latency/
  );

  const [next, ...after] = rest;
  expect(() => assertExplainedShardeControl(
    shown(["Sharding", next, "Hot Shards", ...after]),
    historicalRows,
    strictCases
  )).toThrow(/Hot Shards/);
  expect(() => assertExplainedShardeControl(
    shown(["Hot Shards", "Sharding", ...rest]),
    historicalRows,
    strictCases
  )).toThrow(/Sharding/);
  expect(() => assertExplainedShardeControl(shown(forward), historicalRows.filter((row) => row.index !== 136), strictCases)).toThrow(
    /historical sharde row 136 is missing/
  );
  expect(() => assertExplainedShardeControl(shown(forward), historicalRows.filter((row) => row.index !== 140), strictCases)).toThrow(
    /historical sharde row 140 is missing/
  );
  expect(() => assertExplainedShardeControl(shown(forward), historicalRows, strictCases.filter((row) => row.query !== "sharde"))).toThrow(
    /strict sharde scenario is missing/
  );
  expect(() => assertExplainedShardeControl(
    { titles: forward, ids: forward.slice(1).map((title, index) => `${title}:${index}`) },
    historicalRows,
    strictCases
  )).toThrow(/aligned title and id rows/);
});
