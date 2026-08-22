/**
 * Small deterministic, browser-safe canonical serializer and 64-bit
 * fingerprint. This is compatibility/corruption detection, not a
 * cryptographic authenticity primitive.
 */

function canonical(value: unknown, seen: Set<object>): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value !== "object") return "null";
  if (seen.has(value)) throw new TypeError("Cannot fingerprint a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonical(item, seen)).join(",")}]`;
    }
    const rec = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const item = rec[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      fields.push(`${JSON.stringify(key)}:${canonical(item, seen)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return canonical(value, new Set());
}

export function stableFingerprint(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}
