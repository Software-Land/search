import { moduleSpecifiers, prohibitedBuilderSpecifier, prohibitedBuilderSpecifiers } from "./helpers/import-specifiers.js";

const artifactSource = `
const artifact = { format: "search-relationships", version: 1 };
const stats = { format: "search-corpus-stats", version: 1 };
const index = { format: "search-lexical-index", version: 1 };
export const note = "tools/search-relationships is a directory name in this string";
`;

const importSource = `
import "search-relationships";
import { compile } from "search-corpus";
import local from "./artifacts.js";
export { build } from "search-semantic";
export * from "@software-land/search/lexical";
const dynamic = import("search-lexical");
const required = require("search-enrichment");
const relative = require("../tools/search-corpus/index.js");
const subpath = import("@software-land/search/relationships");
import "search-relationships/index.js";
import "search-corpus/lib/compile.js";
export { compileLexical } from "search-lexical/index.js";
const siblingCorpus = import("../../search-corpus/index.js");
const siblingSemantic = require("../../search-semantic/index.js");
const nested = require("foo/../../search-relationships/index.js");
void local;
void dynamic;
void required;
void relative;
void subpath;
void siblingCorpus;
void siblingSemantic;
void nested;
`;

const allowedSource = `
import root from "@software-land/search";
import browser from "@software-land/search/browser";
import runtime from "./retrieval/retrieve.js";
import other from "../ranking/constraints.js";
import helper from "search-relationships-helper";
import stats from "search-corpus-stats";
import similar from "my-search-lexical";
const artifact = { format: "search-relationships", version: 1 };
const prose = "tools/search-corpus is not an import";
void root;
void browser;
void runtime;
void other;
void helper;
void stats;
void similar;
void artifact;
void prose;
`;

describe("import specifier guard", () => {
  test("artifact values and prose are not imports", () => {
    expect(moduleSpecifiers(artifactSource)).toEqual([]);
    expect(prohibitedBuilderSpecifiers(artifactSource)).toEqual([]);
  });

  test("static imports, re-exports, dynamic import, and require are caught", () => {
    expect(moduleSpecifiers(importSource)).toEqual([
      "search-relationships",
      "search-corpus",
      "./artifacts.js",
      "search-semantic",
      "@software-land/search/lexical",
      "search-lexical",
      "search-enrichment",
      "../tools/search-corpus/index.js",
      "@software-land/search/relationships",
      "search-relationships/index.js",
      "search-corpus/lib/compile.js",
      "search-lexical/index.js",
      "../../search-corpus/index.js",
      "../../search-semantic/index.js",
      "foo/../../search-relationships/index.js",
    ]);
    const prohibited = prohibitedBuilderSpecifiers(importSource).map((row) => row.specifier);
    expect(prohibited).toEqual([
      "search-relationships",
      "search-corpus",
      "search-semantic",
      "@software-land/search/lexical",
      "search-lexical",
      "search-enrichment",
      "../tools/search-corpus/index.js",
      "@software-land/search/relationships",
      "search-relationships/index.js",
      "search-corpus/lib/compile.js",
      "search-lexical/index.js",
      "../../search-corpus/index.js",
      "../../search-semantic/index.js",
      "foo/../../search-relationships/index.js",
    ]);
    expect(prohibitedBuilderSpecifier("./artifacts.js")).toBeNull();
    expect(prohibitedBuilderSpecifier("search-relationships")).toBe("search-relationships");
    expect(prohibitedBuilderSpecifier("search-relationships/index.js")).toBe("search-relationships");
    expect(prohibitedBuilderSpecifier("../../search-semantic/index.js")).toBe("search-semantic");
    expect(prohibitedBuilderSpecifier("@software-land/search")).toBeNull();
    expect(prohibitedBuilderSpecifier("@software-land/search/browser")).toBeNull();
  });

  test("public entries, runtime modules, and similar package names stay allowed", () => {
    expect(moduleSpecifiers(allowedSource)).toEqual([
      "@software-land/search",
      "@software-land/search/browser",
      "./retrieval/retrieve.js",
      "../ranking/constraints.js",
      "search-relationships-helper",
      "search-corpus-stats",
      "my-search-lexical",
    ]);
    expect(prohibitedBuilderSpecifiers(allowedSource)).toEqual([]);
  });
});
