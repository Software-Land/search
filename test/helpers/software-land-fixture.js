/**
 * Software.Land relevance fixture loader shared by Node historical tests
 * and the packed Chromium real-corpus driver.
 * Not Core default ranking policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHistoricalRelevanceApplicable } from "../historical-relevance.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SOFTWARE_LAND_FIXTURE = path.join(ROOT, "..", "fixtures", "software-land");

export function loadSoftwareLandJson(name) {
  return JSON.parse(readFileSync(path.join(SOFTWARE_LAND_FIXTURE, name), "utf8"));
}

function aliasKey(alias) {
  return JSON.stringify(Array.isArray(alias) ? alias : []);
}

export function applyConfiguredConceptPatches(entries, patches) {
  return entries.map((entry) => {
    const patch = patches?.[entry.key];
    if (!patch) return entry;
    const omit = new Set((patch.omitAliases || []).map(aliasKey));
    const aliases = (entry.aliases || []).filter((alias) => !omit.has(aliasKey(alias)));
    const seen = new Set(aliases.map(aliasKey));
    for (const alias of patch.addAliases || []) {
      const form = Array.isArray(alias) ? alias : [];
      const key = aliasKey(form);
      if (!form.length || seen.has(key)) continue;
      seen.add(key);
      aliases.push([...form]);
    }
    return {
      ...entry,
      aliases,
    };
  });
}

export function loadSoftwareLandRelevanceInputs() {
  const relevanceConfig = loadSoftwareLandJson("relevance-config.json");
  const omitKeys = new Set(relevanceConfig.omitConfiguredConceptKeys || []);
  const configuredConcepts = applyConfiguredConceptPatches(
    loadSoftwareLandJson("configured-concepts.json").filter((entry) => !omitKeys.has(entry.key)),
    relevanceConfig.configuredConceptPatches
  );
  const historical = loadSoftwareLandJson("historical-scenarios.json");
  const applicable = historical.rows.filter(isHistoricalRelevanceApplicable);
  return {
    fixtureDir: SOFTWARE_LAND_FIXTURE,
    relevanceConfig,
    documents: loadSoftwareLandJson("documents.json"),
    configuredConcepts,
    lemmas: loadSoftwareLandJson("lemmas.json"),
    relationshipMap: loadSoftwareLandJson(relevanceConfig.relationshipMapFile).map,
    relationships: loadSoftwareLandJson("relationships.json"),
    lexicalFrequency: loadSoftwareLandJson("lexical-frequency.json"),
    historical,
    applicable,
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
  };
}
