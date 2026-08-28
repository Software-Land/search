/**
 * Packed/dist contract for 0.5 authored-relevance init.
 * SearchClient.init sends `configuredConcepts`. A stale tarball that still
 * reads `dictionaryEntries` / compileAuthoredRelevance({ entries }) compiles
 * an empty concept set and then fails closed on relationshipMap concept
 * endpoints such as "http" and "appsec".
 */
export function assertAuthoredRelevanceContract(sources, where = "package") {
  const workerRuntime = String(sources?.workerRuntime || "");
  const configuredConceptsModule = String(sources?.configuredConceptsModule || "");
  const label = String(where || "package");
  if (workerRuntime.includes("payload.dictionaryEntries")) {
    throw new Error(
      `${label} Worker still reads payload.dictionaryEntries; SearchClient.init sends configuredConcepts`
    );
  }
  if (/\bdictionary\s*\(/.test(workerRuntime) || workerRuntime.includes("createWorkerRuntime({ dictionary")) {
    throw new Error(
      `${label} Worker still injects a dictionary factory; use compileConfiguredConceptPlugin`
    );
  }
  if (!workerRuntime.includes("payload.configuredConcepts")) {
    throw new Error(`${label} Worker does not read payload.configuredConcepts`);
  }
  if (!/compileAuthoredRelevance\(\{\s*configuredConcepts/.test(configuredConceptsModule)) {
    throw new Error(`${label} compileAuthoredRelevance does not take configuredConcepts`);
  }
}
