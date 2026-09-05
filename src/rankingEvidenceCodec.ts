/**
 * Packed numeric encodings for FeatureVector enums.
 *
 * classifyDirect() remains the owner of *which* class evidence belongs to.
 * These functions only map that class onto packed storage codes.
 *
 * Invalid codes keep the historical fail-closed decode: unknown DirectClass
 * codes are "none"; unknown field-evidence / configured-match codes are false.
 */

import type { DirectClass, FeatureVector } from "./types.js";

export type ConfiguredFieldEvidenceAtom = false | "key" | "form";

export function encodeDirectClass(value: DirectClass): number {
  if (value === "strong") return 3;
  if (value === "moderate") return 2;
  if (value === "weak") return 1;
  return 0;
}

export function decodeDirectClass(code: number): DirectClass {
  if (code === 3) return "strong";
  if (code === 2) return "moderate";
  if (code === 1) return "weak";
  return "none";
}

export function encodeConfiguredFieldEvidenceAtom(
  value: ConfiguredFieldEvidenceAtom
): number {
  if (value === "key") return 2;
  if (value === "form") return 1;
  return 0;
}

export function decodeConfiguredFieldEvidenceAtom(
  code: number
): ConfiguredFieldEvidenceAtom {
  if (code === 2) return "key";
  if (code === 1) return "form";
  return false;
}

export function packConfiguredFieldEvidence(
  evidence: FeatureVector["configuredConceptFieldEvidence"]
): number {
  return (
    encodeConfiguredFieldEvidenceAtom(evidence.title) |
    (encodeConfiguredFieldEvidenceAtom(evidence.summary) << 2) |
    (encodeConfiguredFieldEvidenceAtom(evidence.body) << 4)
  );
}

export function unpackConfiguredFieldEvidence(
  packed: number
): FeatureVector["configuredConceptFieldEvidence"] {
  return {
    title: decodeConfiguredFieldEvidenceAtom(packed & 3),
    summary: decodeConfiguredFieldEvidenceAtom((packed >> 2) & 3),
    body: decodeConfiguredFieldEvidenceAtom((packed >> 4) & 3),
  };
}

export function encodeConfiguredConceptMatch(
  value: FeatureVector["configuredConceptMatch"]
): number {
  if (value === "key-in-title") return 2;
  if (value === "form") return 1;
  return 0;
}

export function decodeConfiguredConceptMatch(
  code: number
): FeatureVector["configuredConceptMatch"] {
  if (code === 2) return "key-in-title";
  if (code === 1) return "form";
  return false;
}
