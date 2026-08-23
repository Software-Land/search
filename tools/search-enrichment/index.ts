export { enrichCorpus } from "./lib/enrich.js";
export { createFunctionProvider } from "./lib/functionProvider.js";
export { createOpenAICompatibleProvider } from "./lib/openaiCompat.js";
export { validateInferenceResponse } from "./lib/validate.js";
export { INFERENCE_SCHEMA_VERSION, PROMPT_ID, SYSTEM_PROMPT } from "./lib/prompt.js";
export { EnrichmentError } from "./lib/errors.js";
export { createFileCache, createMemoryCache, cacheKeyFor } from "./lib/cache.js";
export { requestFromPhrase } from "./lib/opportunities.js";
export { requestFromDocument } from "./lib/discovery.js";
