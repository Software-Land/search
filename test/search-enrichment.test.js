import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCorpus, LIFECYCLE } from "../tools/search-corpus/index.js";
import {
  EnrichmentError,
  cacheKeyFor,
  createFileCache,
  createFunctionProvider,
  createOpenAICompatibleProvider,
  enrichCorpus,
  requestFromPhrase,
  validateInferenceResponse,
} from "../tools/search-enrichment/index.js";
import { shouldAutoAcceptVerified } from "../tools/search-enrichment/lib/policy.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = "search-enrichment-inference-v1";

function fpsCorpus() {
  return {
    documents: [
      {
        id: "200-fps",
        title: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
        body: [
          "A **200 FPS front-end** produces a new frame approximately every **5 milliseconds**.",
          "Producing 200 frames per second does not guarantee that users will see 200 distinct frames.",
          "Whether 200 FPS is a real product requirement or merely an interesting benchmark matters.",
          "Frame rate describes how frequently new images are produced.",
          "Achieving 200 frames per second requires the display to refresh fast enough.",
          "High FPS budgets leave little room for layout. Another frames per second mention appears here.",
        ].join(" "),
      },
    ],
  };
}

function fpsProposal() {
  return {
    key: "fps",
    expansion: ["frames", "per", "second"],
    relation: "initialism",
    ambiguous: false,
    alternatives: [],
  };
}

function agreeFps(request) {
  if (request.task === "discover-equivalences" || !request.key) {
    return { schemaVersion: SCHEMA, proposals: [] };
  }
  return {
    schemaVersion: SCHEMA,
    proposals: [
      {
        key: request.key,
        expansion: request.minedExpansion,
        relation: "initialism",
        ambiguous: false,
        alternatives: [],
      },
    ],
  };
}

describe("search-enrichment providers and policy", () => {
  test("structured function-provider response is accepted as a proposal", async () => {
    const result = await enrichCorpus(fpsCorpus(), {
      provider: createFunctionProvider(agreeFps),
    });
    const fps = result.proposals.find((p) => p.request.key === "fps");
    expect(fps).toBeTruthy();
    expect(fps.disposition).toBe("agree");
    expect(fps.autoAccepted).toBe(false);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("malformed provider output fails closed", async () => {
    await expect(
      enrichCorpus(fpsCorpus(), {
        provider: createFunctionProvider(() => ({ schemaVersion: "nope", proposals: [] })),
      })
    ).rejects.toBeInstanceOf(EnrichmentError);
  });

  test("provider failure fails closed", async () => {
    await expect(
      enrichCorpus(fpsCorpus(), {
        provider: createFunctionProvider(() => {
          throw new Error("boom");
        }),
      })
    ).rejects.toThrow(/boom/);
  });

  test("timeout fails closed", async () => {
    await expect(
      enrichCorpus(fpsCorpus(), {
        timeoutMs: 20,
        provider: createFunctionProvider(async () => {
          await new Promise((r) => setTimeout(r, 200));
          return agreeFps({ key: "fps", minedExpansion: ["frames", "per", "second"] });
        }),
      })
    ).rejects.toBeInstanceOf(EnrichmentError);
  });

  test("multiple alternatives never auto-accept", async () => {
    const result = await enrichCorpus(fpsCorpus(), {
      autoAcceptVerified: true,
      provider: createFunctionProvider((request) => {
        if (request.task === "discover-equivalences" || !request.key) {
          return { schemaVersion: SCHEMA, proposals: [] };
        }
        return {
          schemaVersion: SCHEMA,
          proposals: [
            {
              key: request.key,
              expansion: request.minedExpansion,
              relation: "initialism",
              ambiguous: true,
              alternatives: [{ expansion: ["first", "person", "shooter"] }],
            },
          ],
        };
      }),
    });
    const fps = result.proposals.find((p) => p.request.key === "fps");
    expect(fps.autoAccepted).toBe(false);
    expect(fps.disposition).toBe("ambiguous");
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("model-only proposals never auto-accept", async () => {
    const result = await enrichCorpus(fpsCorpus(), {
      autoAcceptVerified: true,
      provider: createFunctionProvider(() => ({
        schemaVersion: SCHEMA,
        proposals: [
          {
            key: "xyz",
            expansion: ["x", "y", "z"],
            relation: "initialism",
            ambiguous: false,
            alternatives: [],
          },
        ],
      })),
    });
    expect(result.proposals.some((p) => p.disposition === "model-only" && p.autoAccepted === false)).toBe(true);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "xyz")).toBe(false);
  });

  test("trusted mapping is not replaced by a conflicting model proposal", async () => {
    const result = await enrichCorpus(fpsCorpus(), {
      autoAcceptVerified: true,
      decisions: {
        equivalences: [{ decision: "accept", key: "fps", expansion: ["first", "person", "shooter"], manual: true }],
      },
      provider: createFunctionProvider(agreeFps),
    });
    const compiled = result.compiled.equivalences.entries.find((e) => e.key === "fps");
    expect(compiled.expansion).toEqual(["first", "person", "shooter"]);
    expect(compiled.provenance).not.toBe("verified-enrichment");
  });

  test("autoAcceptVerified remains off by default even with strong evidence and agreement", async () => {
    const compiled = compileCorpus(fpsCorpus());
    expect(compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
    const enriched = await enrichCorpus(fpsCorpus(), { provider: createFunctionProvider(agreeFps) });
    const row = enriched.analysis.life.equivalences.find((c) => c.key === "fps" && c.expansionPhrase === "frames per second");
    expect(row.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(enriched.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("verified auto-accept requires strong independent evidence plus unambiguous agreement", async () => {
    const result = await enrichCorpus(fpsCorpus(), {
      autoAcceptVerified: true,
      provider: createFunctionProvider(agreeFps),
    });
    const row = result.analysis.life.equivalences.find((c) => c.key === "fps" && c.expansionPhrase === "frames per second");
    expect(row.lifecycle).toBe(LIFECYCLE.AUTO_ACCEPTED);
    expect(row.flags).toContain("verified-enrichment");
    expect(row.lifecycle).not.toBe(LIFECYCLE.HUMAN_ACCEPTED);
    const entry = result.compiled.equivalences.entries.find((e) => e.key === "fps");
    expect(entry.expansion).toEqual(["frames", "per", "second"]);
    expect(entry.provenance).toBe("verified-enrichment");
  });

  test("within-document repeats alone do not satisfy verified auto-accept", async () => {
    const corpus = {
      documents: [
        {
          id: "only-body",
          title: "Renderer notes",
          body: "GPU GPU GPU. The graphics processing unit draws the scene. The graphics processing unit is busy.",
        },
      ],
    };
    const result = await enrichCorpus(corpus, {
      autoAcceptVerified: true,
      provider: createFunctionProvider(agreeFps),
    });
    const gpu = result.analysis.life.equivalences.find((c) => c.key === "gpu");
    if (gpu) {
      expect(gpu.lifecycle).not.toBe(LIFECYCLE.AUTO_ACCEPTED);
      expect(result.compiled.equivalences.entries.some((e) => e.key === "gpu")).toBe(false);
    }
  });

  test("cache key changes with corpus, model, and prompt identity", () => {
    const a = cacheKeyFor(
      { schemaVersion: SCHEMA, promptId: "search-enrichment-v1", task: "adjudicate-abbreviation", key: "fps", minedExpansion: ["frames", "per", "second"], evidence: { titleKeyBodyPhrase: 1 }, alternatives: [] },
      { id: "function", model: "fake", temperature: 0, seed: null }
    );
    const b = cacheKeyFor(
      { schemaVersion: SCHEMA, promptId: "search-enrichment-v1", task: "adjudicate-abbreviation", key: "fps", minedExpansion: ["frames", "per", "second"], evidence: { titleKeyBodyPhrase: 2 }, alternatives: [] },
      { id: "function", model: "fake", temperature: 0, seed: null }
    );
    const c = cacheKeyFor(
      { schemaVersion: SCHEMA, promptId: "search-enrichment-v1", task: "adjudicate-abbreviation", key: "fps", minedExpansion: ["frames", "per", "second"], evidence: { titleKeyBodyPhrase: 1 }, alternatives: [] },
      { id: "function", model: "other", temperature: 0, seed: null }
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("file cache replays a prior validated response", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-cache-"));
    const cache = createFileCache(dir);
    let calls = 0;
    const provider = createFunctionProvider((request) => {
      calls += 1;
      return agreeFps(request);
    });
    const first = await enrichCorpus(fpsCorpus(), { provider, cache });
    expect(first.cacheStats.misses).toBeGreaterThan(0);
    expect(first.cacheStats.hits).toBe(0);
    expect(calls).toBe(first.cacheStats.misses);
    const firstCalls = calls;
    const second = await enrichCorpus(fpsCorpus(), { provider, cacheDir: dir });
    expect(second.cacheStats.misses).toBe(0);
    expect(second.cacheStats.hits).toBe(first.cacheStats.writes);
    expect(calls).toBe(firstCalls);
    await enrichCorpus(fpsCorpus(), { provider, cacheDir: dir });
    expect(calls).toBe(firstCalls);
  });

  test("OpenAI-compatible provider uses fetchImpl and never opens a network socket", async () => {
    expect(() => createOpenAICompatibleProvider({ baseUrl: "", model: "x" })).toThrow(EnrichmentError);
    let fetches = 0;
    const provider = createOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:9",
      model: "fake-model",
      fetchImpl: async (_url, init) => {
        fetches += 1;
        const payload = JSON.parse(String(init.body));
        const request = JSON.parse(payload.messages[1].content);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(agreeFps(request)) } }],
          }),
          text: async () => "",
        };
      },
    });
    const result = await enrichCorpus(fpsCorpus(), { provider });
    expect(fetches).toBeGreaterThan(0);
    expect(result.proposals.some((p) => p.request.key === "fps" && p.disposition === "agree")).toBe(true);
  });

  test("validateInferenceResponse rejects fenced or partial payloads", () => {
    expect(() => validateInferenceResponse("```json\n{}\n```")).toThrow(EnrichmentError);
    expect(() => validateInferenceResponse({ schemaVersion: SCHEMA })).toThrow(EnrichmentError);
  });

  test("pending rival expansions block verified auto-accept even when the model agrees strongly with one", async () => {
    const corpus = {
      documents: [
        {
          id: "a",
          title: "ABCD handbook",
          body: "ABCD appears here. The alpha beta compiler demo ships today. The alpha beta compiler demo is documented. ABCD again.",
        },
        {
          id: "b",
          title: "ABCD review",
          body: "ABCD appears here. The account balance check desk is staffed. The account balance check desk closes early. ABCD again.",
        },
      ],
    };
    const compiled = compileCorpus(corpus);
    const abc = compiled.inspection.candidates.filter((c) => c.key === "abcd");
    expect(abc.length).toBeGreaterThanOrEqual(2);
    expect(abc.every((c) => c.lifecycle === LIFECYCLE.REVIEW_PENDING)).toBe(true);

    const result = await enrichCorpus(corpus, {
      autoAcceptVerified: true,
      provider: createFunctionProvider((request) => {
        if (request.task === "discover-equivalences" || !request.key) {
          return { schemaVersion: SCHEMA, proposals: [] };
        }
        return {
          schemaVersion: SCHEMA,
          proposals: [
            {
              key: request.key,
              expansion: request.minedExpansion,
              relation: "initialism",
              ambiguous: false,
              alternatives: [],
              confidence: 1,
            },
          ],
        };
      }),
    });
    expect(result.proposals.some((p) => p.request.key === "abcd" && p.autoAccepted)).toBe(false);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "abcd")).toBe(false);
    expect(
      result.analysis.life.equivalences.filter((c) => c.key === "abcd").every((c) => c.lifecycle !== LIFECYCLE.AUTO_ACCEPTED)
    ).toBe(true);
  });

  test("model confidence cannot override a pending rival veto", () => {
    const peers = [
      {
        id: "fps-frames",
        key: "fps",
        expansion: ["frames", "per", "second"],
        lifecycle: LIFECYCLE.REVIEW_PENDING,
        evidence: {
          keyDf: 3,
          expansionDf: 3,
          titleKeyBodyPhrase: 1,
          titleOccurrencesOfKey: 1,
        },
      },
      {
        id: "fps-first",
        key: "fps",
        expansion: ["first", "person", "shooter"],
        lifecycle: LIFECYCLE.REVIEW_PENDING,
        evidence: { keyDf: 2, expansionDf: 2, titleKeyBodyPhrase: 1 },
      },
    ];
    const verdict = shouldAutoAcceptVerified({
      enabled: true,
      candidate: peers[0],
      proposal: {
        key: "fps",
        expansion: ["frames", "per", "second"],
        relation: "initialism",
        ambiguous: false,
        alternatives: [],
        confidence: 0.99,
      },
      peers,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => /rival/i.test(r))).toBe(true);
  });

  test("non-initialisms do not verified-auto-accept through the strict-initialism path", () => {
    const cases = [
      { key: "db", expansion: ["database"] },
      { key: "appsec", expansion: ["application", "security"] },
      { key: "p99", expansion: ["tail", "latency"] },
    ];
    for (const row of cases) {
      const verdict = shouldAutoAcceptVerified({
        enabled: true,
        candidate: {
          id: row.key,
          key: row.key,
          expansion: row.expansion,
          lifecycle: LIFECYCLE.REVIEW_PENDING,
          evidence: {
            keyDf: 5,
            expansionDf: 5,
            titleKeyBodyPhrase: 2,
            titleOccurrencesOfKey: 2,
            bodyCooccurrences: 2,
            explicitDefinitions: 1,
          },
        },
        proposal: {
          key: row.key,
          expansion: row.expansion,
          relation: "alias",
          ambiguous: false,
          alternatives: [],
          confidence: 1,
        },
        peers: [],
      });
      expect(verdict.ok).toBe(false);
    }
  });

  test("empty or model-only corpora never compile fps", async () => {
    const empty = await enrichCorpus(
      { documents: [{ id: "n", title: "Notes", body: "Nothing abbreviated in this document." }] },
      {
        autoAcceptVerified: true,
        provider: createFunctionProvider(() => ({
          schemaVersion: SCHEMA,
          proposals: [
            {
              key: "fps",
              expansion: ["frames", "per", "second"],
              relation: "initialism",
              ambiguous: false,
              alternatives: [],
              confidence: 1,
            },
          ],
        })),
      }
    );
    expect(empty.proposals.every((p) => p.autoAccepted === false)).toBe(true);
    expect(empty.analysis.life.equivalences.some((c) => c.key === "fps")).toBe(false);
    expect(empty.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);

    const gpuOnly = await enrichCorpus(
      {
        documents: [
          {
            id: "gpu-notes",
            title: "Renderer notes",
            body: "GPU GPU GPU. The graphics processing unit draws the scene. The graphics processing unit is busy.",
          },
        ],
      },
      {
        autoAcceptVerified: true,
        provider: createFunctionProvider(() => ({
          schemaVersion: SCHEMA,
          proposals: [
            {
              key: "fps",
              expansion: ["frames", "per", "second"],
              relation: "initialism",
              ambiguous: false,
              alternatives: [],
            },
          ],
        })),
      }
    );
    expect(gpuOnly.proposals.some((p) => p.request.key === "fps" || p.disposition === "model-only")).toBeTruthy();
    expect(gpuOnly.proposals.every((p) => p.autoAccepted === false)).toBe(true);
    expect(gpuOnly.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("requestFromPhrase supports expansion-only provider tasks without corpus n-gram mining", () => {
    const request = requestFromPhrase(["frames", "per", "second"]);
    expect(request.task).toBe("propose-expansion");
    expect(request.key).toBe("");
    expect(request.phrase).toEqual(["frames", "per", "second"]);
    expect(request.minedExpansion).toEqual(["frames", "per", "second"]);
  });

  test("CLI missing HTTP baseUrl exits nonzero without a stack dump", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-cli-"));
    const input = path.join(tmp, "corpus.json");
    fs.writeFileSync(input, JSON.stringify({ documents: [{ id: "a", title: "A", body: "alpha" }] }));
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "..", "tools", "search-enrichment", "build.mjs"),
        "enrich",
        "--input",
        input,
        "--output",
        path.join(tmp, "out"),
        "--provider",
        "openai-compat",
        "--model",
        "local-model",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SEARCH_ENRICHMENT_API_KEY: "secret-env-key", OPENAI_API_KEY: "openai-secret" },
      }
    );
    expect(result.status).not.toBe(0);
    const err = `${result.stderr || ""}\n${result.stdout || ""}`;
    expect(err).toMatch(/baseUrl/i);
    expect(err).not.toMatch(/secret-env-key|openai-secret/);
    expect(err).not.toMatch(/^\s*at\s+/m);
  });
});

describe("search-enrichment lexical discovery", () => {
  function fpsProposalResponse() {
    return {
      schemaVersion: SCHEMA,
      proposals: [
        {
          key: "fps",
          expansion: ["frames", "per", "second"],
          relation: "initialism",
          ambiguous: false,
          alternatives: [],
        },
      ],
    };
  }

  test("acronym-only document yields review for a model expansion proposal", async () => {
    const corpus = {
      documents: [
        {
          id: "fps-only",
          title: "FPS notes",
          body: "FPS FPS FPS. The renderer reports FPS again without naming the unit in words.",
        },
      ],
    };
    const mined = compileCorpus(corpus);
    expect(mined.inspection.candidates.some((c) => c.key === "fps" && (c.expansionPhrase || "").includes("frames per second"))).toBe(
      false
    );
    const result = await enrichCorpus(corpus, {
      autoAcceptVerified: true,
      provider: createFunctionProvider(() => fpsProposalResponse()),
    });
    const fps = result.analysis.life.equivalences.find(
      (c) => c.key === "fps" && (c.expansionPhrase || (c.expansion || []).join(" ")) === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.proposals.some((p) => p.request.task === "discover-equivalences" && p.autoAccepted === false)).toBe(true);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("expansion-only document yields review for a model acronym proposal", async () => {
    const corpus = {
      documents: [
        {
          id: "timing",
          title: "Display timing",
          body: "The frames per second budget is tiny. Raising frames per second costs power. Measure frames per second directly.",
        },
      ],
    };
    expect(
      compileCorpus(corpus).inspection.candidates.some((c) => c.key === "fps" && c.expansionPhrase === "frames per second")
    ).toBe(false);
    const result = await enrichCorpus(corpus, {
      autoAcceptVerified: true,
      provider: createFunctionProvider(() => fpsProposalResponse()),
    });
    const fps = result.analysis.life.equivalences.find(
      (c) => c.key === "fps" && (c.expansionPhrase || (c.expansion || []).join(" ")) === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("both sides with strong evidence verified-accept only when enabled", async () => {
    const off = await enrichCorpus(fpsCorpus(), {
      provider: createFunctionProvider(() => fpsProposalResponse()),
    });
    const pending = off.analysis.life.equivalences.find(
      (c) => c.key === "fps" && (c.expansionPhrase || "") === "frames per second"
    );
    expect(pending.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(off.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);

    const on = await enrichCorpus(fpsCorpus(), {
      autoAcceptVerified: true,
      provider: createFunctionProvider(() => fpsProposalResponse()),
    });
    const accepted = on.analysis.life.equivalences.find(
      (c) => c.key === "fps" && (c.expansionPhrase || "") === "frames per second"
    );
    expect(accepted.lifecycle).toBe(LIFECYCLE.AUTO_ACCEPTED);
    expect(accepted.flags).toContain("verified-enrichment");
    expect(on.compiled.equivalences.entries.find((e) => e.key === "fps").provenance).toBe("verified-enrichment");
  });

  test("ambiguous discovery stays in review", async () => {
    const result = await enrichCorpus(
      {
        documents: [
          {
            id: "fps-only",
            title: "FPS notes",
            body: "FPS FPS FPS appears without an expansion phrase.",
          },
        ],
      },
      {
        autoAcceptVerified: true,
        provider: createFunctionProvider(() => ({
          schemaVersion: SCHEMA,
          proposals: [
            {
              key: "fps",
              expansion: ["frames", "per", "second"],
              relation: "initialism",
              ambiguous: true,
              alternatives: [{ expansion: ["first", "person", "shooter"] }],
            },
          ],
        })),
      }
    );
    const fps = result.analysis.life.equivalences.find((c) => c.key === "fps");
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.proposals.some((p) => p.disposition === "ambiguous" && p.autoAccepted === false)).toBe(true);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("hallucinated proposal unsupported by the document cannot verified-auto-accept", async () => {
    const result = await enrichCorpus(
      { documents: [{ id: "n", title: "Notes", body: "Nothing abbreviated in this document." }] },
      {
        autoAcceptVerified: true,
        provider: createFunctionProvider(() => fpsProposalResponse()),
      }
    );
    expect(result.analysis.life.equivalences.some((c) => c.key === "fps")).toBe(false);
    expect(result.proposals.every((p) => p.autoAccepted === false)).toBe(true);
    expect(result.compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("file cache replays discovery requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-discover-cache-"));
    const cache = createFileCache(dir);
    let calls = 0;
    const corpus = {
      documents: [
        {
          id: "fps-only",
          title: "FPS notes",
          body: "FPS FPS FPS without an expansion phrase.",
        },
      ],
    };
    const provider = createFunctionProvider(() => {
      calls += 1;
      return fpsProposalResponse();
    });
    const first = await enrichCorpus(corpus, { provider, cache });
    expect(first.cacheStats.misses).toBeGreaterThan(0);
    expect(calls).toBe(first.cacheStats.misses);
    const firstCalls = calls;
    const second = await enrichCorpus(corpus, { provider, cacheDir: dir });
    expect(second.cacheStats.misses).toBe(0);
    expect(second.cacheStats.hits).toBe(first.cacheStats.writes);
    expect(calls).toBe(firstCalls);
  });

  test("discovery context is bounded", async () => {
    const body = `${"padding ".repeat(400)}FPS FPS FPS appears after a long preamble.`;
    let seen = null;
    await enrichCorpus(
      { documents: [{ id: "long", title: "FPS notes", body }] },
      {
        maxContextChars: 80,
        provider: createFunctionProvider((request) => {
          if (request.task === "discover-equivalences") seen = request;
          return { schemaVersion: SCHEMA, proposals: [] };
        }),
      }
    );
    expect(seen).toBeTruthy();
    expect(seen.task).toBe("discover-equivalences");
    expect(seen.context.length).toBeLessThanOrEqual(80);
    expect(seen.title.length).toBeLessThanOrEqual(80);
    expect(seen.maxProposals).toBeGreaterThan(0);
  });
});
