import { EnrichmentError } from "./errors.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { LexicalInferenceProvider, LexicalInferenceRequest, LexicalInferenceResponse } from "../types.js";

export function createOpenAICompatibleProvider({
  baseUrl,
  model,
  apiKey,
  timeoutMs = 15000,
  temperature = 0,
  seed = null,
  fetchImpl,
}: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  seed?: number | null;
  fetchImpl?: typeof fetch;
}): LexicalInferenceProvider {
  if (!baseUrl || !String(baseUrl).trim()) {
    throw new EnrichmentError("OpenAI-compatible provider requires baseUrl");
  }
  if (!model || !String(model).trim()) {
    throw new EnrichmentError("OpenAI-compatible provider requires model");
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new EnrichmentError("fetch is not available; Node.js 18+ is required");
  }
  const root = String(baseUrl).replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;

  return {
    id: "openai-compat",
    model,
    temperature,
    seed,
    async infer(request: LexicalInferenceRequest, options?: { signal?: AbortSignal }): Promise<LexicalInferenceResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      const onAbort = () => controller.abort();
      options?.signal?.addEventListener("abort", onAbort);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const body: Record<string, unknown> = {
          model,
          temperature,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(request) },
          ],
        };
        if (seed != null) body.seed = seed;
        const res = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new EnrichmentError(`OpenAI-compatible provider HTTP ${res.status}`, [await res.text().catch(() => "")]);
        }
        const payload = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new EnrichmentError("OpenAI-compatible provider returned empty content");
        }
        if (/^```/.test(content.trim())) {
          throw new EnrichmentError("OpenAI-compatible provider returned fenced content; JSON object required");
        }
        try {
          return JSON.parse(content) as LexicalInferenceResponse;
        } catch {
          throw new EnrichmentError("OpenAI-compatible provider returned non-JSON content");
        }
      } catch (err) {
        if (err instanceof EnrichmentError) throw err;
        if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
          throw new EnrichmentError(`OpenAI-compatible provider timed out after ${timeoutMs}ms`);
        }
        throw new EnrichmentError(`OpenAI-compatible provider failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
