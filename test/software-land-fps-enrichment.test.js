import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCorpus, LIFECYCLE } from "../tools/search-corpus/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function loadSoftwareLandBlog(root) {
  const blog = path.join(root, "content", "blog");
  if (!fs.existsSync(blog)) return null;
  const documents = [];
  for (const name of fs.readdirSync(blog)) {
    const file = path.join(blog, name, "index.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const titleMatch = fm ? fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m) : null;
    documents.push({
      id: name,
      title: titleMatch ? titleMatch[1].replace(/^"|"$/g, "") : name,
      body: fm ? fm[2] : raw,
    });
  }
  return documents.length ? { documents } : null;
}

const siblingRoots = [
  path.resolve(__dirname, "../../software.land"),
  path.resolve(__dirname, "../../software.land-search-wire"),
  "/home/sam/dev/software.land",
  "/home/sam/dev/software.land-search-wire",
];

describe("Software.Land fps mining diagnostic", () => {
  test("always-on 200FPS excerpt mines fps as review-pending", () => {
    const result = compileCorpus(ALWAYS_ON);
    const fps = result.inspection.candidates.find(
      (c) => c.key === "fps" && c.expansionPhrase === "frames per second"
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(result.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });

  test("optional sibling Software.Land corpus keeps fps in review", () => {
    const root = siblingRoots.find((dir) => fs.existsSync(path.join(dir, "content", "blog")));
    if (!root) return;
    const corpus = loadSoftwareLandBlog(root);
    if (!corpus) return;
    const compiled = compileCorpus(corpus);
    const fps = compiled.inspection.candidates.find(
      (c) => c.key === "fps" && (c.expansionPhrase || "").includes("frames per second")
    );
    expect(fps).toBeTruthy();
    expect(fps.lifecycle).toBe(LIFECYCLE.REVIEW_PENDING);
    expect(compiled.equivalences.entries.some((e) => e.key === "fps")).toBe(false);
  });
});
