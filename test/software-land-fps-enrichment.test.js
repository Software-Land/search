import { compileCorpus, LIFECYCLE } from "../tools/search-corpus/index.js";

const ALWAYS_ON = {
  documents: [
    {
      id: "200-fps-css-vs-canvas-vs-webgl-vs-webgpu",
      title: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      body: [
        "A **200 FPS front-end** produces a new frame approximately every **5 milliseconds**.",
        "That budget is extremely small: JavaScript, React work, style, layout, paint, composite, and GPU work must finish in time.",
        "Producing 200 frames per second does not guarantee that users will see 200 distinct frames.",
        "The display must also refresh at 200 Hz or faster.",
        "Whether 200 FPS is a real product requirement or merely an interesting benchmark depends on the hardware.",
        "Frame rate describes how frequently new images are produced. Frame time is the inverse.",
        "Achieving 200 frames per second is therefore not about selecting WebGL by default.",
      ].join("\n"),
    },
  ],
};

describe("Software.Land fps mining diagnostic", () => {
  test("always-on 200FPS excerpt mines fps as review-pending", () => {
    const result = compileCorpus(ALWAYS_ON);
    const fps = result.inspection.candidates.find(
      (c) => c.key === "fps" && c.expansionPhrase === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.configuredConcepts.some((e) => e.key === "fps")).toBe(false);
  });
});
