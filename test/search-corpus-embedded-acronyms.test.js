import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCorpus, LIFECYCLE } from "../tools/search-corpus/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fpsDoc() {
  return {
    id: "200-fps",
    title: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
    body: [
      "A **200 FPS front-end** produces a new frame approximately every **5 milliseconds**.",
      "Producing 200 frames per second does not guarantee that users will see 200 distinct frames.",
      "Whether 200 FPS is a real product requirement or merely an interesting benchmark matters.",
      "Frame rate describes how frequently new images are produced. FPS is the usual unit.",
      "Achieving 200 frames per second requires the display to refresh fast enough.",
      "High FPS budgets leave little room for layout. Another frames per second mention appears here.",
    ].join(" "),
  };
}

describe("search-corpus embedded acronyms", () => {
  test("200FPS title yields fps → frames per second as review, not auto-accept", () => {
    const result = compileCorpus({ documents: [fpsDoc()] });
    const fps = result.inspection.candidates.find(
      (c) => c.key === "fps" && c.expansionPhrase === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.initialsMatch).toBe(true);
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(fps.compilerStatus || fps.status).toBe("review");
    expect(result.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
    expect(fps.evidence.titleKeyBodyPhrase).toBeGreaterThanOrEqual(1);
    expect(result.inspection.candidates.some((c) => ["cvc", "cvcvw", "cvw", "cvwvw"].includes(c.key))).toBe(false);
  });

  test("within-document repeats surface a short key for review without auto-accept", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "gpu-notes",
          title: "Renderer notes",
          body: "GPU GPU GPU. The graphics processing unit draws the scene. The graphics processing unit is busy.",
        },
      ],
    });
    const gpu = result.inspection.candidates.find(
      (c) => c.key === "gpu" && c.expansionPhrase === "graphics processing unit"
    );
    expect(gpu).toBeTruthy();
    expect(gpu.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.equivalences.entries.some((e) => e.key === "gpu")).toBe(false);
  });

  test("expansion-only phrases do not invent initialism keys", () => {
    const result = compileCorpus({
      documents: [
        {
          id: "timing",
          title: "Display timing",
          body: "The frames per second budget is tiny. Raising frames per second costs power. Measure frames per second directly.",
        },
      ],
    });
    const fps = result.inspection.candidates.find(
      (c) => c.key === "fps" && c.expansionPhrase === "frames per second"
    );
    expect(fps).toBeFalsy();
    expect(result.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
    expect(result.inspection.candidates.some((c) => (c.evidence?.provenances || []).includes("generated-initialism"))).toBe(
      false
    );
  });

  test("122-document Software.Land fixture stays near historical candidate volume", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "software-land", "documents.json"), "utf8")
    );
    const documents = raw.map((d) => ({ id: d.id, title: d.title, body: d.body }));
    const result = compileCorpus({ documents });
    const candidates = result.inspection.candidates || [];
    const accepted = result.inspection.counts?.accepted ?? result.inspection.accepted?.length ?? 0;
    const review = result.inspection.counts?.review ?? result.inspection.review?.length ?? 0;
    const rejected = result.inspection.counts?.rejected ?? result.inspection.rejected?.length ?? 0;
    expect(candidates.length).toBeLessThan(80);
    expect(review).toBeLessThan(40);
    expect(accepted + review + rejected).toBe(candidates.length);
    const fps = candidates.find((c) => c.key === "fps" && c.expansionPhrase === "frames per second");
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
    expect(candidates.some((c) => (c.evidence?.provenances || []).includes("generated-initialism"))).toBe(false);
  });

  test("ambiguous initialisms stay in review even with title keys", () => {
    const result = compileCorpus({
      documents: [
        { id: "a", title: "ABC: Alpha Beta Compiler", body: "Alpha Beta Compiler and ABC. Alpha Beta Compiler again." },
        { id: "b", title: "ABC: Account Balance Check", body: "Account Balance Check and ABC. Account Balance Check again." },
      ],
    });
    const abc = result.inspection.candidates.filter((c) => c.key === "abc");
    expect(abc.length).toBeGreaterThanOrEqual(2);
    expect(abc.every((c) => c.lifecycle !== LIFECYCLE.AUTO_ACCEPTED)).toBe(true);
    expect(result.equivalences.entries.some((e) => e.key === "abc")).toBe(false);
  });

  test("numeric-attached suffixes are acronym evidence only when independently observed standalone", () => {
    const fps200 = compileCorpus({
      documents: [
        {
          id: "200",
          title: "200FPS benchmark",
          body: "FPS FPS. The frames per second budget is tiny. Raising frames per second costs power.",
        },
      ],
    });
    expect(
      fps200.inspection.candidates.some((c) => c.key === "fps" && c.expansionPhrase === "frames per second")
    ).toBe(true);

    const fps240 = compileCorpus({
      documents: [
        {
          id: "240",
          title: "240FPS benchmark",
          body: "Standalone FPS appears here. The frames per second budget is tiny. Raising frames per second costs power.",
        },
      ],
    });
    expect(
      fps240.inspection.candidates.some((c) => c.key === "fps" && c.expansionPhrase === "frames per second")
    ).toBe(true);

    const lowercaseToken = compileCorpus({
      documents: [
        {
          id: "lower",
          title: "200FPS benchmark",
          body: "a 200 fps front end. producing 200 frames per second. another frames per second mention.",
        },
      ],
    });
    expect(
      lowercaseToken.inspection.candidates.some((c) => c.key === "fps" && c.expansionPhrase === "frames per second")
    ).toBe(true);

    const twoFa = compileCorpus({
      documents: [
        {
          id: "fa",
          title: "Account security",
          body: "Enable 2FA on every account. 2FA 2FA. Factor authentication is mentioned without FA as a token.",
        },
      ],
    });
    expect(twoFa.inspection.candidates.some((c) => c.key === "fa")).toBe(false);

    const threeGb = compileCorpus({
      documents: [
        {
          id: "mem",
          title: "Memory notes",
          body: "A 3GB heap is large. Another 3GB region. Gigabyte scale without GB as an acronym.",
        },
      ],
    });
    expect(threeGb.inspection.candidates.some((c) => c.key === "gb")).toBe(false);
  });

  test("decision aliases and primary compile through to dictionary entries", () => {
    const result = compileCorpus(
      {
        documents: [{ id: "x", title: "Notes", body: "No acronym evidence here." }],
      },
      {
        decisions: {
          equivalences: [
            {
              decision: "accept",
              key: "api",
              aliases: [["application", "programming", "interface"], ["app", "iface"]],
              primary: "api",
              manual: true,
            },
          ],
        },
      }
    );
    const entry = result.equivalences.entries.find((e) => e.key === "api");
    expect(entry).toBeTruthy();
    expect(entry.aliases).toEqual([
      ["application", "programming", "interface"],
      ["app", "iface"],
    ]);
    expect(entry.primary).toBeUndefined();
    const dict = result.configuredConcepts.find((e) => e.key === "api");
    expect(dict.aliases).toEqual([
      ["application", "programming", "interface"],
      ["app", "iface"],
    ]);
    expect(dict.primary).toBeUndefined();
  });
});
