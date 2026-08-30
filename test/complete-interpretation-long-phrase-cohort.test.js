/**
 * Complete-interpretation collector: contiguous long-phrase cohort vs
 * scattered lexical overlap. Neutral synthetic tokens. Not a product fixture.
 */
import { SearchEngine } from "../dist/index.js";
import { COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/completeInterpretationCollector.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const PHRASE = "keldor vinta plomex quarn ziblet nador fexun";
const COLLECTOR = { limit: 10, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR };

function engineWith(docs) {
  const engine = SearchEngine.create({ schema, retriever: "full-scan" });
  return engine.index(docs).then(() => engine);
}

describe("complete-interpretation long phrase cohort", () => {
  test("exact 7-token phrase keeps the contiguous document and drops scattered overlap", async () => {
    const engine = await engineWith([
      { id: "A", title: PHRASE, summary: "", body: "unrelated filler" },
      {
        id: "B",
        title: "unrelated heading",
        summary: "",
        body: "keldor filler vinta filler plomex filler quarn filler ziblet filler nador filler fexun",
      },
    ]);
    const off = engine.search(PHRASE, { limit: 10 }).map((h) => h.id);
    expect(off).toEqual(expect.arrayContaining(["A", "B"]));
    expect(engine.search(PHRASE, COLLECTOR).map((h) => h.id)).toEqual(["A"]);
  });

  test("every genuine contiguous phrase match survives; scattered overlap does not", async () => {
    const engine = await engineWith([
      { id: "A", title: PHRASE, summary: "", body: "unrelated filler" },
      {
        id: "B",
        title: "unrelated heading",
        summary: "",
        body: "keldor filler vinta filler plomex filler quarn filler ziblet filler nador filler fexun",
      },
      { id: "C", title: "separate article", summary: "", body: `prefix ${PHRASE} suffix` },
    ]);
    const off = engine.search(PHRASE, { limit: 10 }).map((h) => h.id);
    expect(off).toEqual(expect.arrayContaining(["A", "B", "C"]));
    expect(engine.search(PHRASE, COLLECTOR).map((h) => h.id)).toEqual(["A", "C"]);
  });
});
