/**
 * Test-only split of leftover recall fields onto relationshipMap.
 * Production authoring uses relationshipMap directly.
 */
import { compileAuthoredRelevance } from "../../dist/index.js";

export function splitAuthored(entries = []) {
  const authored = [];
  const relationshipMap = {};
  for (const entry of entries || []) {
    const { topicalRecall, standaloneRecall, expansion, exp, primary, ...rest } = entry;
    authored.push(rest);
    if (Array.isArray(topicalRecall)) {
      if (!relationshipMap[entry.key]) relationshipMap[entry.key] = [];
      for (const form of topicalRecall) {
        if (!Array.isArray(form) || !form.length) continue;
        const tokens = [];
        let malformed = false;
        for (const tok of form) {
          const token = String(tok ?? "").toLowerCase().trim();
          if (!token || /\s/.test(token)) {
            malformed = true;
            break;
          }
          tokens.push(token);
        }
        if (malformed || !tokens.length) continue;
        relationshipMap[entry.key].push({ to: { form: tokens }, kind: "related" });
      }
      if (!relationshipMap[entry.key].length) delete relationshipMap[entry.key];
    }
    if (Array.isArray(standaloneRecall)) {
      for (const token of standaloneRecall) {
        const t = String(token || "").toLowerCase().trim();
        if (!t || /\s/.test(t)) continue;
        if (!relationshipMap[t]) relationshipMap[t] = [];
        relationshipMap[t].push({ to: { concept: entry.key }, kind: "related" });
      }
    }
  }
  return {
    entries: authored,
    relationshipMap: Object.keys(relationshipMap).length ? relationshipMap : undefined,
  };
}

export function pluginByName(authored, name) {
  return authored.plugins.find((plugin) => plugin.name === name);
}

export function dictionaryFromLegacy(entries, extra = {}) {
  const split = splitAuthored(entries);
  return pluginByName(
    compileAuthoredRelevance({
      entries: split.entries,
      relationshipMap: extra.relationshipMap || split.relationshipMap,
      documents: extra.documents,
    }),
    "dictionary"
  );
}
