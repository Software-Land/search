/**
 * Authored relationshipMap keys must not collide with Object.prototype.
 * Forbidden prototype-pollution names are rejected after trim.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidConfigurationError } from "../dist/index.js";
import { compileRelationshipMap } from "../dist/relationships/relationshipMap.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "dist", "relationships", "relationshipMap.js");

function mapFromJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function equivalentMap(source, target = "testing") {
  return JSON.parse(
    `{"${String(source).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}":[{"to":{"form":${JSON.stringify(target)}},"kind":"equivalent"}]}`
  );
}

describe("relationshipMap arbitrary-key storage", () => {
  test("A. toString compiles as an authored equivalent source", () => {
    const compiled = compileRelationshipMap(
      mapFromJson({ toString: [{ to: { form: "testing" }, kind: "equivalent" }] })
    );
    expect(compiled.synonymMap.toString).toEqual(["testing"]);
    expect(Object.keys(compiled.synonymMap)).toEqual(["toString"]);
    expect(JSON.stringify(compiled.synonymMap)).toBe('{"toString":["testing"]}');
    expect(({}).toString).toBe(Object.prototype.toString);
  });

  test("B. valueOf compiles as an authored equivalent source", () => {
    const compiled = compileRelationshipMap(
      mapFromJson({ valueOf: [{ to: { form: "testing" }, kind: "equivalent" }] })
    );
    expect(compiled.synonymMap.valueOf).toEqual(["testing"]);
    expect(JSON.stringify(compiled.synonymMap)).toBe('{"valueOf":["testing"]}');
  });

  test("C. hasOwnProperty compiles as an authored equivalent source", () => {
    const compiled = compileRelationshipMap(
      mapFromJson({ hasOwnProperty: [{ to: { form: "testing" }, kind: "equivalent" }] })
    );
    expect(compiled.synonymMap.hasOwnProperty).toEqual(["testing"]);
    expect(JSON.stringify(compiled.synonymMap)).toBe('{"hasOwnProperty":["testing"]}');
  });

  test("D. whitespace-normalized forbidden keys are rejected", () => {
    for (const source of [" constructor ", " __proto__ ", " prototype ", "constructor", "__proto__", "prototype"]) {
      expect(() => compileRelationshipMap(equivalentMap(source))).toThrow(InvalidConfigurationError);
      expect(() => compileRelationshipMap(equivalentMap(source))).toThrow(/forbidden relationshipMap key/);
    }
  });

  test("E. document id toString accumulates as an editorial source", () => {
    const compiled = compileRelationshipMap(
      mapFromJson({ toString: [{ to: { document: "vpn" }, kind: "related" }] }),
      { documents: [{ id: "toString", title: "To String" }, { id: "vpn", title: "What is VPN?" }] }
    );
    expect(compiled.editorialRelationships.toString).toEqual([
      { target: "vpn", type: "editorial", strength: 1, provenance: "manual" },
    ]);
    expect(Object.keys(compiled.editorialRelationships)).toEqual(["toString"]);
    expect(JSON.stringify(compiled.editorialRelationships)).toBe(
      '{"toString":[{"target":"vpn","type":"editorial","strength":1,"provenance":"manual"}]}'
    );
    expect(compiled.editorialRelationships.vpn).toBeUndefined();
  });

  test("F. public JSON shape stays a deterministic string-keyed record", () => {
    const compiled = compileRelationshipMap({
      qa: [{ to: { form: "testing" }, kind: "equivalent" }],
      toString: [{ to: { form: "testing" }, kind: "equivalent" }],
    });
    expect(compiled.synonymMap.qa).toEqual(["testing"]);
    expect(compiled.synonymMap.toString).toEqual(["testing"]);
    expect(JSON.parse(JSON.stringify(compiled.synonymMap))).toEqual({
      qa: ["testing"],
      toString: ["testing"],
    });
    const empty = compileRelationshipMap(null);
    expect(JSON.stringify(empty.synonymMap)).toBe("{}");
    expect(JSON.stringify(empty.editorialRelationships)).toBe("{}");
  });

  test("malicious authored keys cannot pollute Object.prototype", () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const probe = {};
    expect(probe.polluted).toBeUndefined();

    compileRelationshipMap(mapFromJson({ toString: [{ to: { form: "testing" }, kind: "equivalent" }] }));
    compileRelationshipMap(mapFromJson({ valueOf: [{ to: { form: "testing" }, kind: "equivalent" }] }));
    expect(() => compileRelationshipMap(equivalentMap("__proto__"))).toThrow(/forbidden relationshipMap key/);
    expect(() => compileRelationshipMap(equivalentMap(" constructor "))).toThrow(/forbidden relationshipMap key/);

    expect(probe.polluted).toBeUndefined();
    expect(({}).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    expect(probe.toString).toBe(Object.prototype.toString);
  });

  test("isolated process compilation cannot write Object.prototype", () => {
    const script = `
      import { compileRelationshipMap } from ${JSON.stringify(DIST)};
      const before = Object.getOwnPropertyNames(Object.prototype).join("\\0");
      const parse = (value) => JSON.parse(value);
      compileRelationshipMap(parse('{"toString":[{"to":{"form":"testing"},"kind":"equivalent"}]}'));
      const forbidden = [
        '{"__proto__":[{"to":{"form":"testing"},"kind":"equivalent"}]}',
        '{" constructor ":[{"to":{"form":"testing"},"kind":"equivalent"}]}',
        '{" prototype ":[{"to":{"form":"testing"},"kind":"equivalent"}]}',
      ];
      for (const raw of forbidden) {
        try { compileRelationshipMap(parse(raw)); process.exit(10); } catch {}
      }
      if (({}).polluted !== undefined) process.exit(2);
      if (Object.getOwnPropertyNames(Object.prototype).join("\\0") !== before) process.exit(3);
      if (typeof ({}).toString !== "function") process.exit(4);
      process.stdout.write("clean");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      cwd: path.join(ROOT, ".."),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
    expect(result.stderr).toBe("");
  });
});
