/**
 * Configured-content identity is not occupancy. Remainder must be structural
 * wrappers (WH / copula / determiner) before a suffix exact span. Connectors
 * and prefix spans do not qualify.
 */
import { morphology } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const dict = [
  {
    key: "api",
    aliases: [["application", "programming", "interface"], ["app", "programming", "interface"]],
  },
  { key: "rpc", aliases: [["remote", "procedure", "call"]] },
  { key: "tls", aliases: [["transport", "layer", "security"]] },
  { key: "oauth", aliases: [["open", "authorization"]] },
  {
    key: "oop",
    aliases: [["object", "oriented", "programming"]],
  },
];

function plugins() {
  return [morphology(), configuredConceptPluginFromLegacy(dict)];
}

function identity(raw) {
  return analyzeQuery(raw, { plugins: plugins() }).configuredContentIdentity?.key ?? null;
}

function occupancy(raw) {
  return analyzeQuery(raw, { plugins: plugins() }).configuredSequenceIntent?.key ?? null;
}

describe("configured content identity", () => {
  test("does not broaden occupancy for wrapped keys", () => {
    expect(occupancy("what is an api")).toBeNull();
    expect(occupancy("an api")).toBeNull();
    expect(occupancy("the api")).toBeNull();
    expect(occupancy("what is rpc")).toBeNull();
    expect(occupancy("api")).toBe("api");
  });

  test("recognizes wrapper-complete unique concepts", () => {
    expect(identity("what is an api")).toBe("api");
    expect(identity("what is rpc")).toBe("rpc");
    expect(identity("what is tls")).toBe("tls");
    expect(identity("an api")).toBe("api");
    expect(identity("the api")).toBe("api");
    expect(identity("api")).toBe("api");
  });

  test("rejects incomplete lexical completion and leftover content", () => {
    expect(identity("what is an ap")).toBeNull();
    expect(identity("what is an applicatio")).toBeNull();
    expect(identity("api rpc")).toBeNull();
    expect(identity("api authorization")).toBeNull();
    expect(identity("object oriented programming vs functional")).toBeNull();
    expect(identity("explain oauth")).toBeNull();
    expect(identity("explain api")).toBeNull();
  });

  test("rejects connector and incomplete composition remainders", () => {
    for (const raw of [
      "api and",
      "api vs",
      "api with",
      "api of",
      "api to",
      "and api",
      "vs api",
      "with api",
      "of api",
      "to api",
      "api and rpc",
      "api vs rpc",
      "what is api vs",
      "what is an api and",
      "what is an api vs rpc",
    ]) {
      expect(identity(raw)).toBeNull();
    }
  });

  test("prefix spans never qualify", () => {
    const q = analyzeQuery("what is an applicatio", { plugins: plugins() });
    expect(q.configuredPrefixSpans?.length).toBeGreaterThan(0);
    expect(q.configuredSpans || []).toEqual([]);
    expect(q.configuredContentIdentity).toBeNull();
  });

  test("occupancy stays null while wrapper identity is set", () => {
    const q = analyzeQuery("what is rpc", { plugins: plugins() });
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredContentIdentity?.key).toBe("rpc");
  });
});
