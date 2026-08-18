import { isSymmetricType } from "./types.js";

/** @param {unknown} value */
export function normalizeRef(value) {
  return String(value || "").trim();
}

/** @param {unknown} value */
export function normalizePath(value) {
  let s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/#.*$/, "");
  if (!s.startsWith("/")) s = `/${s}`;
  if (!s.endsWith("/")) s = `${s}/`;
  return s;
}

/** @param {string} source @param {string} target */
export function pairKey(source, target) {
  return `${source}::${target}`;
}

/** @param {string} source @param {string} target @param {{ symmetric?: boolean }} [opts] @returns {[string, string]} */
export function orderedPair(source, target, { symmetric = false } = {}) {
  const a = String(source);
  const b = String(target);
  if (!symmetric) return [a, b];
  return a <= b ? [a, b] : [b, a];
}

/**
 * Stable identity: type + endpoints.
 * Symmetric types normalize pair order. Directional types keep source→target.
 */
/** @param {unknown} type @param {unknown} source @param {unknown} target @param {{ directional?: boolean }} [opts] */
export function relationshipId(type, source, target, { directional = false } = {}) {
  const t = String(type || "editorial").toLowerCase();
  const symmetric = isSymmetricType(t, { directional });
  const [a, b] = orderedPair(String(source), String(target), { symmetric });
  return `relationship:${t}:${a}:${b}`;
}
