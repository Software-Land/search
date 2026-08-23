import type { LexicalInferenceProvider, LexicalInferenceRequest, LexicalInferenceResponse } from "../types.js";

export function createFunctionProvider(
  fn: (request: LexicalInferenceRequest, options?: { signal?: AbortSignal }) => LexicalInferenceResponse | Promise<LexicalInferenceResponse>,
  { id = "function", model = "fake", temperature = 0, seed = null }: { id?: string; model?: string; temperature?: number; seed?: number | null } = {}
): LexicalInferenceProvider {
  return {
    id,
    model,
    temperature,
    seed,
    async infer(request, options) {
      if (options?.signal?.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return fn(request, options);
    },
  };
}
