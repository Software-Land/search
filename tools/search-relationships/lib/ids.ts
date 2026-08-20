import { isSymmetricType } from "./types.js";

export function normalizeRef(value: unknown): string {
  return String(value || "").trim();
}

export function normalizePath(value: unknown): string {
  let s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/#.*$/, "");
  if (!s.startsWith("/")) s = `/${s}`;
  if (!s.endsWith("/")) s = `${s}/`;
  return s;
}

export function pairKey(source: string, target: string): string {
  return `${source}::${target}`;
}

export function orderedPair(source: string, target: string, { symmetric = false }: { symmetric?: boolean } = {}): [string, string] {
  const a = String(source);
  const b = String(target);
  if (!symmetric) return [a, b];
  return a <= b ? [a, b] : [b, a];
}

/**
 * Stable identity: type + endpoints.
 * Symmetric types normalize pair order. Directional types keep source→target.
 */
export function relationshipId(type: unknown, source: unknown, target: unknown, { directional = false }: { directional?: boolean } = {}): string {
  const t = String(type || "editorial").toLowerCase();
  const symmetric = isSymmetricType(t, { directional });
  const [a, b] = orderedPair(String(source), String(target), { symmetric });
  return `relationship:${t}:${a}:${b}`;
}
