import { SearchEngine, morphology, english } from "../dist/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const lemmas = { widgets: "widget", foobars: "foobaz" };

async function titlesOf(plugin, query) {
  const engine = SearchEngine.create({
    schema,
    plugins: [plugin],
    retriever: "full-scan",
  });
  await engine.index([
    { id: "recursion", title: "What is Recursion?", body: "A function that calls itself." },
    { id: "widget", title: "What is a Widget?", body: "A reusable UI widget." },
    { id: "compute", title: "Edge Computing", body: "Compute at the edge." },
  ]);
  return engine.search(query, { limit: 3 }).map((hit) => hit.title);
}

describe("morphology() / english() compatibility", () => {
  test("english remains importable from the public root export", () => {
    expect(typeof morphology).toBe("function");
    expect(typeof english).toBe("function");
  });

  test("english({ lemmas }) and morphology({ lemmas }) are equivalent", async () => {
    const viaMorphology = morphology({ lemmas });
    const viaEnglish = english({ lemmas });
    expect(viaMorphology.name).toBe("english");
    expect(viaEnglish.name).toBe("english");
    expect(viaMorphology.lemma("recurses")).toBe(viaEnglish.lemma("recurses"));
    expect(viaMorphology.lemma("widgets")).toBe(viaEnglish.lemma("widgets"));
    expect(viaMorphology.lemma("computing")).toBe(viaEnglish.lemma("computing"));
    expect(viaMorphology.canonicalLemma("recurses")).toBe(viaEnglish.canonicalLemma("recurses"));
    expect(viaMorphology.lemma("widgets")).toBe("widget");
    expect(viaMorphology.lemma("computing")).toBe("compute");

    const morphDefault = morphology();
    const englishDefault = english();
    expect(await titlesOf(morphDefault, "recurses")).toEqual(await titlesOf(englishDefault, "recurses"));
    expect(await titlesOf(viaMorphology, "widgets")).toEqual(await titlesOf(viaEnglish, "widgets"));
    expect(await titlesOf(viaMorphology, "computing")).toEqual(await titlesOf(viaEnglish, "computing"));
    expect((await titlesOf(morphDefault, "recurses"))[0]).toBe("What is Recursion?");
  });
});
