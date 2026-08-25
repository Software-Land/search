/**
 * Transform Software.Land Search V2 scenario policy into OSS fixtures.
 *
 * Repo-only. No Gatsby, UI, V1 engine, TestCafe, or network.
 * Reads `tests/search-scenarios.js` and `tests/search-v2-contracts.js`.
 *
 * Outputs:
 *   v2-contracts.json          strict accepted V2 (A-class intent + SEARCH_V2_CONTRACTS)
 *   regression-scenarios.json  B-class independent intent, compatibility coverage only
 *   historical-scenarios.json  all 215 source rows; v1.expectedTop/titlePrefix are
 *                              executable historical relevance contracts (membership
 *                              within topN). disposition is V2-intent mining provenance.
 *   scenarios.json             index + counts
 *
 * V1 expectedTop is the historical relevance contract. It is not a V2 intent
 * contract and is not an exact-output oracle.
 * Empty-intent rows are not mined into V2 intent/regression cases; they still
 * participate in historical relevance when expectedTop/titlePrefix exist.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TLS_RELATIONSHIP_EVIDENCE = {
  title: "What is VPN?",
  relevanceKind: "related",
  type: "editorial",
  provenance: "manual",
  sourceTitle: "TLS 1.2 Vulnerability",
};

/** Recorded B intent that current fixture V2 does not satisfy as #1. */
const B_INTENT_NOT_CURRENT_V2 = new Set(["what is an appli"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function scenarioClassification(scenario) {
  const raw = String(scenario?.classification || "").trim().toUpperCase();
  if (raw === "B" || raw === "C") return raw;
  return "A";
}

function scenarioIntent(scenario) {
  return scenario?.intent || {};
}

function hasEngineIndependentIntent(scenario) {
  const intent = scenarioIntent(scenario);
  if (intent.titlePrefix) return true;
  if (Array.isArray(intent.requiredPrimary) && intent.requiredPrimary.length) return true;
  if (Array.isArray(intent.requiredWithin) && intent.requiredWithin.length) return true;
  if (Array.isArray(intent.requiredAnyWithin) && intent.requiredAnyWithin.length) return true;
  return false;
}

function isV2ApplicableScenario(scenario) {
  return scenarioClassification(scenario) === "A" && hasEngineIndependentIntent(scenario);
}

function isHistoricalRelevanceApplicable(scenario) {
  if (scenarioClassification(scenario) === "C") return false;
  const v1 = scenario?.v1 && typeof scenario.v1 === "object" ? scenario.v1 : {};
  if (v1.titlePrefix) return true;
  return Array.isArray(v1.expectedTop) && v1.expectedTop.length > 0;
}

function compactList(value) {
  return Array.isArray(value) && value.length ? value : undefined;
}

function fromIntent(scenario, kind, origin) {
  const intent = scenarioIntent(scenario);
  const row = {
    query: scenario.query,
    kind,
    origin,
    classification: scenarioClassification(scenario),
  };
  if (intent.titlePrefix) {
    row.titlePrefix = intent.titlePrefix;
    row.titlePrefixTopN = intent.topN ?? 10;
  }
  const within = compactList(intent.requiredWithin);
  if (within) row.requiredWithin = within;
  const anyWithin = compactList(intent.requiredAnyWithin);
  if (anyWithin) row.requiredAnyWithin = anyWithin;
  const exactFirst = within?.find((item) => item.topN === 1);
  if (exactFirst) row.exactFirst = exactFirst.title;
  return row;
}

function fromContract(contract) {
  const row = {
    query: contract.query,
    kind: "contract",
    origin: "v2-contract",
  };
  if (contract.titlePrefix) {
    row.titlePrefix = contract.titlePrefix;
    row.titlePrefixTopN = contract.topN ?? 10;
  }
  if (contract.requiredPrimary) row.exactFirst = contract.requiredPrimary;
  if (contract.requiredAnyTop) row.requiredAnyTop = contract.requiredAnyTop;
  if (contract.forbiddenDominance) {
    row.mustNotDominate = {
      primary: contract.requiredPrimary,
      titles: contract.forbiddenDominance,
    };
  }
  if (contract.requiredRelatedAny) row.requiredRelatedAny = contract.requiredRelatedAny;
  if (contract.query === "tls") row.relationship = { ...TLS_RELATIONSHIP_EVIDENCE };
  return row;
}

function executableKey(row) {
  const { name, kind, origin, classification, ...rest } = row;
  return JSON.stringify({ query: rest.query, rest });
}

function intentKey(scenario) {
  return JSON.stringify({ query: scenario.query, intent: scenarioIntent(scenario) });
}

function assertionFingerprint(row) {
  const parts = [];
  if (row.exactFirst) parts.push(`#1:${row.exactFirst}`);
  for (const item of row.requiredWithin || []) parts.push(`${item.title}@${item.topN}`);
  for (const item of row.requiredAnyWithin || []) parts.push(`any:${item.title}@${item.topN}`);
  if (row.requiredAnyTop) {
    parts.push(`anyTop:${row.requiredAnyTop.titles.join(", ")}@${row.requiredAnyTop.topN}`);
  }
  if (row.titlePrefix) parts.push(`prefix:${row.titlePrefix}@${row.titlePrefixTopN ?? 10}`);
  if (row.mustNotDominate) parts.push(`notAbove:${row.mustNotDominate.titles.join(", ")}`);
  if (row.requiredRelatedAny) parts.push("relatedAny");
  if (row.relationship) parts.push("relationship");
  return parts.join(" | ") || row.origin;
}

function caseName(row, used) {
  let name = `${row.kind} · ${row.origin} · ${row.query} · ${assertionFingerprint(row)}`;
  if (used.has(name)) name = `${name} · ${used.size}`;
  used.add(name);
  return name;
}

function provenanceV1(scenario) {
  const v1 = scenario?.v1 && typeof scenario.v1 === "object" ? scenario.v1 : {};
  const out = {};
  if (Array.isArray(v1.expectedTop) && v1.expectedTop.length) out.expectedTop = v1.expectedTop;
  if (v1.titlePrefix) out.titlePrefix = v1.titlePrefix;
  if (v1.topN != null) out.topN = v1.topN;
  return Object.keys(out).length ? out : undefined;
}

async function loadModule(filePath) {
  return import(pathToFileURL(path.resolve(filePath)).href);
}

function sha256Bytes(filePath) {
  const buf = readFileSync(filePath);
  return {
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Usage:
  node scripts/software-land-scenarios.mjs \\
    --scenarios /path/to/tests/search-scenarios.js \\
    --contracts /path/to/tests/search-v2-contracts.js \\
    --dir test/fixtures/software-land \\
    [--manifest test/fixtures/software-land/manifest.json]`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.scenarios || !args.contracts || !args.dir) {
  console.error(usage());
  process.exit(1);
}

const scenarioMod = await loadModule(args.scenarios);
const contractMod = await loadModule(args.contracts);
const scenarios = scenarioMod.scenarios;
const contracts = contractMod.SEARCH_V2_CONTRACTS;

if (!Array.isArray(scenarios) || !Array.isArray(contracts)) {
  throw new Error("Expected scenarios[] and SEARCH_V2_CONTRACTS[] exports");
}

const dir = path.resolve(args.dir);
const usedNames = new Set();

const contractCases = [];
const seenContract = new Set();
for (const scenario of scenarios.filter(isV2ApplicableScenario)) {
  const row = fromIntent(scenario, "contract", "scenario");
  const key = executableKey(row);
  if (seenContract.has(key)) continue;
  seenContract.add(key);
  row.name = caseName(row, usedNames);
  contractCases.push(row);
}
for (const contract of contracts) {
  const row = fromContract(contract);
  row.name = caseName(row, usedNames);
  contractCases.push(row);
}
const contractQueries = new Set(contractCases.map((row) => row.query));

const regressionCases = [];
const seenRegression = new Set();
for (const scenario of scenarios) {
  if (scenarioClassification(scenario) !== "B") continue;
  if (!hasEngineIndependentIntent(scenario)) continue;
  if (contractQueries.has(scenario.query)) continue;
  if (B_INTENT_NOT_CURRENT_V2.has(scenario.query)) continue;
  const row = fromIntent(scenario, "regression", "scenario");
  const key = executableKey(row);
  if (seenRegression.has(key)) continue;
  seenRegression.add(key);
  row.name = caseName(row, usedNames);
  regressionCases.push(row);
}

const seenAIntent = new Set();
const seenBIntent = new Set();
const historical = scenarios.map((scenario, index) => {
  const classification = scenarioClassification(scenario);
  const independent = hasEngineIndependentIntent(scenario);
  const key = intentKey(scenario);
  let disposition;
  let note;
  if (classification === "C") {
    disposition = "omitted-obsolete";
    note = scenario.obsoleteReason || "Obsolete. Enforced on neither V1 nor V2.";
  } else if (classification === "A" && independent) {
    if (seenAIntent.has(key)) {
      disposition = "omitted-duplicate-a-intent";
      note = "Duplicate of an A-class independent intent already in v2-contracts.json.";
    } else {
      seenAIntent.add(key);
      disposition = "contract-a-intent";
      note = "Executable strict V2 contract from A-class independent intent.";
    }
  } else if (classification === "B" && independent) {
    if (contractQueries.has(scenario.query)) {
      disposition = "omitted-covered-by-v2-contract";
      note = "Query is already asserted by a strict V2 contract. Historical expectedTop still participates in the relevance suite.";
    } else if (B_INTENT_NOT_CURRENT_V2.has(scenario.query)) {
      disposition = "omitted-b-intent-not-current-v2";
      note = "Recorded B intent is not current fixture V2 behavior. Not mined into regression.";
    } else if (seenBIntent.has(key)) {
      disposition = "omitted-duplicate-b-intent";
      note = "Duplicate of a B-class independent intent already in regression-scenarios.json.";
    } else {
      seenBIntent.add(key);
      disposition = "regression-b-intent";
      note = "Executable Software.Land compatibility coverage. Not Core ranking policy.";
    }
  } else {
    disposition = "omitted-empty-intent-observational-v1";
    note = "No independent V2 intent. Historical expectedTop/titlePrefix still participate in the relevance suite.";
  }
  const row = {
    index,
    query: scenario.query,
    classification,
    disposition,
    note,
    intent: scenarioIntent(scenario),
    historicalRelevance: isHistoricalRelevanceApplicable(scenario),
  };
  const v1 = provenanceV1(scenario);
  if (v1) row.v1 = v1;
  if (scenario.obsoleteReason) row.obsoleteReason = scenario.obsoleteReason;
  return row;
});

const dispositionCounts = {};
for (const row of historical) {
  dispositionCounts[row.disposition] = (dispositionCounts[row.disposition] || 0) + 1;
}

const counts = {
  sourceScenarioRows: scenarios.length,
  distinctQueries: new Set(scenarios.map((row) => row.query)).size,
  v2ApplicableRows: scenarios.filter(isV2ApplicableScenario).length,
  v2Contracts: contracts.length,
  executableContracts: contractCases.length,
  executableRegressions: regressionCases.length,
  historicalRows: historical.length,
  historicalRelevanceApplicable: historical.filter((row) => row.historicalRelevance).length,
  omittedObsolete: dispositionCounts["omitted-obsolete"] || 0,
  omittedEmptyIntent: dispositionCounts["omitted-empty-intent-observational-v1"] || 0,
  omittedCoveredByContract: dispositionCounts["omitted-covered-by-v2-contract"] || 0,
  omittedBIntentNotCurrentV2: dispositionCounts["omitted-b-intent-not-current-v2"] || 0,
  omittedDuplicateA: dispositionCounts["omitted-duplicate-a-intent"] || 0,
  omittedDuplicateB: dispositionCounts["omitted-duplicate-b-intent"] || 0,
  omittedBrowserUiOnly: 1,
};

const indexPayload = {
  notes: [
    "Software.Land-derived realistic integration test data. It is not default package policy.",
    "v2-contracts.json is the strict accepted V2 contract set.",
    "regression-scenarios.json is B-class independent-intent compatibility coverage, not Core ranking policy.",
    "historical-scenarios.json is the full 215-row inventory. v1.expectedTop/titlePrefix/topN are executable historical relevance contracts (membership within topN).",
    "disposition describes V2-intent mining, not relevance-suite inclusion. Classification C is omitted from relevance.",
    "V2 intent contracts do not replace historical expectedTop.",
    "Empty-intent rows are not mined into V2 intent/regression cases.",
  ],
  source: {
    files: ["tests/search-scenarios.js", "tests/search-v2-contracts.js"],
    policy: "A-class independent intent + SEARCH_V2_CONTRACTS; B-intent regressions are compatibility coverage only",
  },
  counts,
  dispositionCounts,
  files: {
    "v2-contracts.json": "Strict accepted V2 cases (kind: contract).",
    "regression-scenarios.json": "B-intent regression/reference cases (kind: regression).",
    "historical-scenarios.json": "215-row inventory; expectedTop/titlePrefix are executable historical relevance contracts.",
  },
};

const contractPayload = {
  kind: "contract",
  notes: [
    "Strict accepted Search V2 assertions. Not Core default ranking policy.",
    "A-class independent intent plus SEARCH_V2_CONTRACTS.",
    "V1 expectedTop is not asserted.",
  ],
  counts: { cases: contractCases.length },
  cases: contractCases,
};

const regressionPayload = {
  kind: "regression",
  notes: [
    "Software.Land compatibility coverage from recorded B-class independent intent.",
    "Not Core ranking policy. Not V1 expectedTop bags.",
    "Empty-intent rows are excluded.",
  ],
  counts: { cases: regressionCases.length },
  cases: regressionCases,
};

const historicalPayload = {
  kind: "historical-relevance-contracts",
  notes: [
    "Full historical scenario inventory.",
    "v1.expectedTop / titlePrefix / topN are executable historical relevance contracts (membership within topN, not exact order).",
    "classification C is omitted from the relevance suite (obsolete).",
    "All other rows with expectedTop or titlePrefix participate. Failures are not silently excluded.",
    "disposition describes V2-intent mining into v2-contracts.json / regression-scenarios.json, not relevance-suite inclusion.",
  ],
  counts: {
    rows: historical.length,
    historicalRelevanceApplicable: historical.filter((row) => row.historicalRelevance).length,
    ...dispositionCounts,
  },
  rows: historical,
};

const paths = {
  index: path.join(dir, "scenarios.json"),
  contracts: path.join(dir, "v2-contracts.json"),
  regressions: path.join(dir, "regression-scenarios.json"),
  historical: path.join(dir, "historical-scenarios.json"),
};

writeJson(paths.index, indexPayload);
writeJson(paths.contracts, contractPayload);
writeJson(paths.regressions, regressionPayload);
writeJson(paths.historical, historicalPayload);

const omittedV1OnlyRows = scenarios.filter(
  (row) => scenarioClassification(row) !== "C" && !isV2ApplicableScenario(row)
).length;

if (args.manifest) {
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  manifest.scenarioCount = counts.sourceScenarioRows;
  manifest.executableV2ScenarioCount = counts.executableContracts;
  manifest.executableRegressionCount = counts.executableRegressions;
  manifest.historicalScenarioCount = counts.historicalRows;
  manifest.historicalRelevanceApplicable = counts.historicalRelevanceApplicable;
  manifest.omittedV1OnlyCount = omittedV1OnlyRows;
  manifest.omittedEmptyIntentCount = counts.omittedEmptyIntent;
  manifest.omittedBrowserUiOnlyCount = 1;
  manifest.sourceScenarioFiles = ["tests/search-scenarios.js", "tests/search-v2-contracts.js"];
  manifest.files = manifest.files || {};
  for (const [name, filePath] of Object.entries({
    "scenarios.json": paths.index,
    "v2-contracts.json": paths.contracts,
    "regression-scenarios.json": paths.regressions,
    "historical-scenarios.json": paths.historical,
  })) {
    manifest.files[name] = sha256Bytes(filePath);
  }
  writeJson(args.manifest, manifest);
}

console.log(
  JSON.stringify(
    {
      dir,
      ...counts,
    },
    null,
    2
  )
);
