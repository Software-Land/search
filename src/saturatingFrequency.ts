/**
 * Shared saturating transform for compiled occurrence counts.
 * Runtime and lexical tooling import this module. The lexical compiler/tool
 * tree is not imported from root or browser.
 *
 * log1p(count) / (1 + log1p(count)) — monotonic, bounded in [0, 1).
 */
export function saturatingFrequency(count: number): number {
  const n = Math.max(0, Number(count) || 0);
  const x = Math.log1p(n);
  return Number((x / (1 + x)).toFixed(4));
}
