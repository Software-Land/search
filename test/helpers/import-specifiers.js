/**
 * Literal module specifiers from JavaScript source.
 * Uses the TypeScript parser already installed for this repository.
 * Artifact strings that are not import/export/require arguments are ignored.
 */
import path from "node:path";
import ts from "typescript";

const BUILDER_BARE_NAMES = new Set([
  "search-semantic",
  "search-lexical",
  "search-corpus",
  "search-relationships",
  "search-enrichment",
]);

const PUBLIC_BUILDER_SUBPATHS = new Set(["semantic", "lexical", "corpus", "relationships"]);

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

export function moduleSpecifiers(source, fileName = "module.js") {
  const sourceFile = ts.createSourceFile(fileName, String(source || ""), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specs = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const text = literalText(node.moduleSpecifier);
      if (text) specs.push(text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      const dynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(callee) && callee.text === "require";
      if (dynamicImport || requireCall) {
        const text = literalText(node.arguments[0]);
        if (text) specs.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

function specifierSegments(specifier) {
  const text = String(specifier || "").replaceAll("\\", "/").replace(/\/+$/g, "");
  return path.posix.normalize(text).split("/").filter((part) => part && part !== "." && part !== "..");
}

export function prohibitedBuilderSpecifier(specifier) {
  const segments = specifierSegments(specifier);
  for (let index = 0; index < segments.length - 2; index += 1) {
    const subpath = segments[index + 2];
    if (segments[index] === "@software-land" && segments[index + 1] === "search" && PUBLIC_BUILDER_SUBPATHS.has(subpath)) {
      return `@software-land/search/${subpath}`;
    }
  }
  for (const segment of segments) {
    if (BUILDER_BARE_NAMES.has(segment)) return segment;
  }
  return null;
}

export function prohibitedBuilderSpecifiers(source, fileName) {
  return moduleSpecifiers(source, fileName)
    .map((specifier) => ({ specifier, prohibited: prohibitedBuilderSpecifier(specifier) }))
    .filter((row) => row.prohibited);
}
