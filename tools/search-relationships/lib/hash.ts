import crypto from "node:crypto";

export function sha256Hex(text: unknown): string {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function stableSort<T>(arr: T[], keyFn: (item: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}
