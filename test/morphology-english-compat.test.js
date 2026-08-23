import { SearchEngine, morphology } from "../dist/index.js";
import { english as internalEnglish } from "../dist/english.js";
import * as publicApi from "../dist/index.js";

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

describe("0.4.0 morphology() public API", () => {
  test("root english export is removed", () => {
    expect(typeof morphology).toBe("function");
    expect(publicApi).not.toHaveProperty("english");
    expect(publicApi.PUBLIC_EXPORTS).not.toContain("english");
  });

  test("morphology() is the English plugin and matches the internal factory", async () => {
    const viaMorphology = morphology({ lemmas });
    const viaInternal = internalEnglish({ lemmas });
    expect(viaMorphology.name).toBe("english");
    expect(viaInternal.name).toBe("english");
    expect(viaMorphology.lemma("recurses")).toBe(viaInternal.lemma("recurses"));
    expect(viaMorphology.lemma("widgets")).toBe(viaInternal.lemma("widgets"));
    expect(viaMorphology.lemma("computing")).toBe(viaInternal.lemma("computing"));
    expect(viaMorphology.canonicalLemma("recurses")).toBe(viaInternal.canonicalLemma("recurses"));
    expect(viaMorphology.lemma("widgets")).toBe("widget");
    expect(viaMorphology.lemma("computing")).toBe("compute");

    const morphDefault = morphology();
    const internalDefault = internalEnglish();
    expect(await titlesOf(morphDefault, "recurses")).toEqual(await titlesOf(internalDefault, "recurses"));
    expect(await titlesOf(viaMorphology, "widgets")).toEqual(await titlesOf(viaInternal, "widgets"));
    expect(await titlesOf(viaMorphology, "computing")).toEqual(await titlesOf(viaInternal, "computing"));
    expect((await titlesOf(morphDefault, "recurses"))[0]).toBe("What is Recursion?");
  });

  test("built-in recursion family maps to recursion without a site table", () => {
    const plugin = morphology();
    const inflected = ["recurses", "recursing", "recursive", "recursively", "recursed"];
    for (const form of inflected) {
      expect(plugin.canonicalLemma(form)).toBe("recursion");
      expect(plugin.lemma(form)).toBe("recursion");
    }
    expect(plugin.canonicalLemma("recurse")).toBeNull();
    expect(plugin.canonicalLemma("recurs")).toBeNull();
    expect(plugin.lemma("recurs")).toBe("recur");
    expect(plugin.canonicalLemma("recursion")).toBeNull();
  });

  test("recursion family is not an unbounded recurs* stem", () => {
    const plugin = morphology();
    expect(plugin.canonicalLemma("recur")).toBeNull();
    expect(plugin.canonicalLemma("resource")).toBeNull();
    expect(plugin.canonicalLemma("recourse")).toBeNull();
    expect(plugin.canonicalLemma("cursor")).toBeNull();
    expect(plugin.canonicalLemma("secure")).toBeNull();
    expect(plugin.lemma("recur")).toBe("recur");
    expect(plugin.lemma("resource")).toBe("resource");
  });

  test("an explicit supplied lemma joins its canonical family", async () => {
    const plugin = morphology({ lemmas: { recurse: "recursion", xyzzy: "widget" } });
    const expected = await titlesOf(plugin, "recursion");
    expect(expected[0]).toBe("What is Recursion?");
    expect(plugin.canonicalLemma("recurse")).toBe("recursion");
    expect(await titlesOf(plugin, "recurse")).toEqual(expected);
    expect(plugin.canonicalLemma("xyzzy")).toBe("widget");
    expect((await titlesOf(plugin, "xyzzy"))[0]).toBe("What is a Widget?");
  });
});
