import crypto from "node:crypto";

export function sha256Hex(text: unknown): string {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}
