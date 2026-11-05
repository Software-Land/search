import { SearchEngine } from "../dist/index.js";
import {
  EXACT_PRUNING_BLOCK_BOUNDARIES_EXTENSION,
  EXACT_PRUNING_BLOCK_BOUNDARIES_LEGACY_EXTENSION,
  EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION,
  EXACT_PRUNING_BODY_TERM_MASKS_LEGACY_EXTENSION,
  LEXICAL_INDEX_VERSION,
  compileLexicalIndex,
  loadLexicalIndex,
  parseLexicalIndex,
} from "../dist/indexing/lexicalIndex.js";
import { stableFingerprint } from "../dist/stableHash.js";

const BOUNDARIES = EXACT_PRUNING_BLOCK_BOUNDARIES_EXTENSION;
const BOUNDARIES_LEGACY = EXACT_PRUNING_BLOCK_BOUNDARIES_LEGACY_EXTENSION;
const MASKS = EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION;
const MASKS_LEGACY = EXACT_PRUNING_BODY_TERM_MASKS_LEGACY_EXTENSION;

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function refreshIntegrity(artifact) {
  artifact.integrity = stableFingerprint({
    compatibility: artifact.compatibility,
    corpus: artifact.corpus,
    data: artifact.data,
  });
  return artifact;
}

function clone(artifact) {
  return JSON.parse(JSON.stringify(artifact));
}

function retarget(artifact, replacements) {
  const copy = clone(artifact);
  for (const [from, to] of replacements) {
    if (!Object.prototype.hasOwnProperty.call(copy.data.extensions, from)) {
      throw new Error(`missing extension ${from}`);
    }
    copy.data.extensions[to] = copy.data.extensions[from];
    delete copy.data.extensions[from];
  }
  return refreshIntegrity(copy);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function engineFor(documents, lexicalIndex) {
  const engine = SearchEngine.create({
    schema,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await engine.index(documents);
  return engine;
}

function featureCorpus() {
  const documents = [{ id: "winner", title: "The", body: "" }];
  for (let i = 0; i < 300; i += 1) {
    documents.push({
      id: `body-${String(i).padStart(6, "0")}`,
      title: `Article ${i}`,
      body: "the common body",
    });
  }
  return documents;
}

function maskCorpus() {
  return Array.from({ length: 400 }, (_, i) => ({
    id: `weak-${String(i).padStart(5, "0")}`,
    title: `Note ${i}`,
    body: i % 2 === 0 ? "alpha only here" : "beta only here",
  }));
}

function publicRows(hits) {
  return hits.map((hit) => ({ id: hit.id, score: hit.score, rank: hit.rank }));
}

function featureEvidence(meta) {
  return {
    documentsBoundRejected: meta.documentsBoundRejected,
    documentBlocksSkipped: meta.documentBlocksSkipped,
    pruningFallbackReason: meta.pruningFallbackReason,
    mode: meta.pruningMode,
  };
}

function maskEvidence(meta) {
  return {
    stage3A: meta.stage3A,
    postingBlocksClassifiedFromMasks: meta.postingBlocksClassifiedFromMasks,
    postingBlocksSkippedUnread: meta.postingBlocksSkippedUnread,
    postingBlocksDecoded: meta.postingBlocksDecoded,
  };
}

describe("exact pruning extension identifiers", () => {
  test("writers emit canonical names and payload revision 1 at lexical schema version 1", () => {
    const artifact = compileLexicalIndex(featureCorpus(), { schema });
    expect(artifact.version).toBe(LEXICAL_INDEX_VERSION);
    expect(artifact.version).toBe(1);
    expect(Object.keys(artifact.data.extensions).sort()).toEqual([BOUNDARIES, MASKS].sort());
    expect(artifact.data.extensions[BOUNDARIES].revision).toBe(1);
    expect(artifact.data.extensions[MASKS].revision).toBe(1);
    expect(artifact.data.extensions[BOUNDARIES_LEGACY]).toBeUndefined();
    expect(artifact.data.extensions[MASKS_LEGACY]).toBeUndefined();
  });

  test("legacy aliases and mixed families activate the same pruning as canonical writers", async () => {
    const featureDocuments = featureCorpus();
    const featureCanonical = compileLexicalIndex(featureDocuments, { schema });
    const featureLegacy = retarget(featureCanonical, [[BOUNDARIES, BOUNDARIES_LEGACY], [MASKS, MASKS_LEGACY]]);
    const featureMixed = retarget(featureCanonical, [[MASKS, MASKS_LEGACY]]);
    const featureReverse = retarget(featureCanonical, [[BOUNDARIES, BOUNDARIES_LEGACY]]);

    async function featureRun(artifact) {
      const engine = await engineFor(featureDocuments, artifact);
      const pruned = engine._searchDetailedSync("the", { limit: 10, relatedLimit: 0 }, false);
      const exhaustive = engine._searchDetailedSync("the", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
      return { pruned, exhaustive };
    }

    const canonicalFeatures = await featureRun(featureCanonical);
    const legacyFeatures = await featureRun(featureLegacy);
    const mixedFeatures = await featureRun(featureMixed);
    const reverseFeatures = await featureRun(featureReverse);
    const active = featureEvidence(canonicalFeatures.pruned.meta);
    expect(active.documentsBoundRejected).toBeGreaterThan(0);
    expect(active.pruningFallbackReason).toBeNull();
    expect(featureEvidence(canonicalFeatures.exhaustive.meta).documentsBoundRejected).toBe(0);
    for (const run of [legacyFeatures, mixedFeatures, reverseFeatures]) {
      expect(featureEvidence(run.pruned.meta)).toEqual(active);
      expect(publicRows(run.pruned.results)).toEqual(publicRows(canonicalFeatures.pruned.results));
      expect(publicRows(run.exhaustive.results)).toEqual(publicRows(canonicalFeatures.exhaustive.results));
    }

    const maskDocuments = maskCorpus();
    const maskCanonical = compileLexicalIndex(maskDocuments, { schema });
    const maskLegacy = retarget(maskCanonical, [[BOUNDARIES, BOUNDARIES_LEGACY], [MASKS, MASKS_LEGACY]]);
    const maskMixed = retarget(maskCanonical, [[BOUNDARIES, BOUNDARIES_LEGACY]]);
    const maskReverse = retarget(maskCanonical, [[MASKS, MASKS_LEGACY]]);

    async function maskRun(artifact) {
      const engine = await engineFor(maskDocuments, artifact);
      const pruned = engine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "auto");
      const exhaustive = engine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "exhaustive");
      return { pruned, exhaustive };
    }

    const canonicalMasks = await maskRun(maskCanonical);
    const legacyMasks = await maskRun(maskLegacy);
    const mixedMasks = await maskRun(maskMixed);
    const reverseMasks = await maskRun(maskReverse);
    const masks = maskEvidence(canonicalMasks.pruned.meta);
    expect(masks.stage3A).toBe("applied");
    expect(masks.postingBlocksClassifiedFromMasks).toBeGreaterThan(0);
    expect(masks.postingBlocksSkippedUnread).toBeGreaterThan(0);
    expect(maskEvidence(canonicalMasks.exhaustive.meta).postingBlocksSkippedUnread || 0).toBe(0);
    for (const run of [legacyMasks, mixedMasks, reverseMasks]) {
      expect(maskEvidence(run.pruned.meta)).toEqual(masks);
      expect(publicRows(run.pruned.results)).toEqual(publicRows(canonicalMasks.pruned.results));
      expect(publicRows(run.exhaustive.results)).toEqual(publicRows(canonicalMasks.exhaustive.results));
    }
  });

  test("each family can be absent without disabling the other", async () => {
    const featureDocuments = featureCorpus();
    const boundariesOnly = clone(compileLexicalIndex(featureDocuments, { schema }));
    delete boundariesOnly.data.extensions[MASKS];
    refreshIntegrity(boundariesOnly);
    const featureEngine = await engineFor(featureDocuments, boundariesOnly);
    const featureMeta = featureEngine._searchDetailedSync("the", { limit: 10, relatedLimit: 0 }, false).meta;
    expect(featureMeta.documentsBoundRejected).toBeGreaterThan(0);
    expect(featureMeta.pruningFallbackReason).toBeNull();

    const missingBoundaries = clone(compileLexicalIndex(featureDocuments, { schema }));
    delete missingBoundaries.data.extensions[BOUNDARIES];
    refreshIntegrity(missingBoundaries);
    const missingEngine = await engineFor(featureDocuments, missingBoundaries);
    const missingMeta = missingEngine._searchDetailedSync("the", { limit: 10, relatedLimit: 0 }, false).meta;
    expect(missingMeta.documentsBoundRejected).toBe(0);
    expect(missingMeta.pruningFallbackReason).toBe("missing-pruning-extension");

    const maskDocuments = maskCorpus();
    const masksOnly = clone(compileLexicalIndex(maskDocuments, { schema }));
    delete masksOnly.data.extensions[BOUNDARIES];
    refreshIntegrity(masksOnly);
    const maskEngine = await engineFor(maskDocuments, masksOnly);
    const maskMeta = maskEngine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "auto").meta;
    expect(maskMeta.stage3A).toBe("applied");
    expect(maskMeta.postingBlocksSkippedUnread).toBeGreaterThan(0);

    const missingMasks = clone(compileLexicalIndex(maskDocuments, { schema }));
    delete missingMasks.data.extensions[MASKS];
    refreshIntegrity(missingMasks);
    const noMaskEngine = await engineFor(maskDocuments, missingMasks);
    const noMaskMeta = noMaskEngine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "auto").meta;
    expect(noMaskMeta.postingBlocksSkippedUnread || 0).toBe(0);
    expect(noMaskMeta.stage3A === "off" || noMaskMeta.stage3A === "fallback").toBe(true);
  });

  test("duplicate spellings of one family reject even when the values match", () => {
    const documents = featureCorpus();
    const artifact = compileLexicalIndex(documents, { schema });
    for (const [canonical, legacy, family] of [
      [BOUNDARIES, BOUNDARIES_LEGACY, "block-boundaries"],
      [MASKS, MASKS_LEGACY, "body-term-masks"],
    ]) {
      const duplicated = clone(artifact);
      duplicated.data.extensions[legacy] = JSON.parse(JSON.stringify(duplicated.data.extensions[canonical]));
      refreshIntegrity(duplicated);
      expect(() => loadLexicalIndex(duplicated, documents, schema)).toThrow(
        new RegExp(`both ${canonical} and ${legacy} for the same ${family} extension`)
      );
    }
  });

  test("malformed metadata and unsupported revisions reject under either spelling", () => {
    const documents = featureCorpus();
    const artifact = compileLexicalIndex(documents, { schema });
    for (const key of [BOUNDARIES, BOUNDARIES_LEGACY]) {
      const malformed = key === BOUNDARIES ? clone(artifact) : retarget(artifact, [[BOUNDARIES, BOUNDARIES_LEGACY]]);
      malformed.data.extensions[key] = { revision: 1 };
      refreshIntegrity(malformed);
      expect(() => parseLexicalIndex(malformed)).toThrow(new RegExp(key));

      const unsupported = key === BOUNDARIES ? clone(artifact) : retarget(artifact, [[BOUNDARIES, BOUNDARIES_LEGACY]]);
      unsupported.data.extensions[key].revision = 2;
      refreshIntegrity(unsupported);
      expect(() => parseLexicalIndex(unsupported)).toThrow(new RegExp(`${key}.*revision is unsupported|revision is unsupported`));
      expect(() => parseLexicalIndex(unsupported)).toThrow(new RegExp(key));
    }
    for (const key of [MASKS, MASKS_LEGACY]) {
      const malformed = key === MASKS ? clone(artifact) : retarget(artifact, [[MASKS, MASKS_LEGACY]]);
      malformed.data.extensions[key] = [];
      refreshIntegrity(malformed);
      expect(() => parseLexicalIndex(malformed)).toThrow(new RegExp(key));

      const unsupported = key === MASKS ? clone(artifact) : retarget(artifact, [[MASKS, MASKS_LEGACY]]);
      unsupported.data.extensions[key].revision = 9;
      refreshIntegrity(unsupported);
      expect(() => parseLexicalIndex(unsupported)).toThrow(new RegExp(key));
    }
  });

  test("integrity is checked on the original bytes before alias resolution", () => {
    const documents = featureCorpus();
    const canonical = compileLexicalIndex(documents, { schema });
    const renamed = clone(canonical);
    renamed.data.extensions[BOUNDARIES_LEGACY] = renamed.data.extensions[BOUNDARIES];
    delete renamed.data.extensions[BOUNDARIES];
    expect(() => parseLexicalIndex(renamed)).toThrow(/integrity/);

    const legacy = refreshIntegrity(clone(renamed));
    legacy.data.extensions["unrelated-extension"] = { note: "kept" };
    refreshIntegrity(legacy);
    const before = JSON.stringify(legacy);
    const data = legacy.data;
    const extensions = legacy.data.extensions;
    deepFreeze(legacy);
    const parsed = parseLexicalIndex(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(parsed.artifact.data).toBe(data);
    expect(parsed.artifact.data.extensions).toBe(extensions);
    expect(parsed.artifact.integrity).toBe(legacy.integrity);
    expect(parsed.artifact.data.extensions[BOUNDARIES_LEGACY]).toBeDefined();
    expect(parsed.artifact.data.extensions[BOUNDARIES]).toBeUndefined();
    expect(parsed.artifact.data.extensions["unrelated-extension"]).toEqual({ note: "kept" });
    expect(stableFingerprint({
      compatibility: parsed.artifact.compatibility,
      corpus: parsed.artifact.corpus,
      data: parsed.artifact.data,
    })).toBe(parsed.artifact.integrity);
    expect(parsed.payload.extensions[BOUNDARIES]).toEqual(canonical.data.extensions[BOUNDARIES]);
    expect(parsed.payload.extensions[BOUNDARIES_LEGACY]).toBeUndefined();
    expect(parsed.payload.extensions[MASKS]).toEqual(canonical.data.extensions[MASKS]);
    expect(parsed.payload.extensions["unrelated-extension"]).toEqual({ note: "kept" });
    const rewritten = {
      ...parsed.artifact.data,
      extensions: parsed.payload.extensions,
    };
    expect(stableFingerprint({
      compatibility: parsed.artifact.compatibility,
      corpus: parsed.artifact.corpus,
      data: rewritten,
    })).not.toBe(parsed.artifact.integrity);

    const tampered = clone(legacy);
    tampered.integrity = `${tampered.integrity.slice(0, -1)}${tampered.integrity.endsWith("a") ? "b" : "a"}`;
    expect(() => parseLexicalIndex(tampered)).toThrow(/integrity/);
  });
});
