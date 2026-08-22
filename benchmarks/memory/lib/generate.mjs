/**
 * Deterministic synthetic corpora for memory benchmarks.
 * Seed 0x5e1ec7 matches the 0.3.1 memory investigation.
 *
 * `article` uses a closed overlapping vocabulary (high DF). It reproduces
 * full-scan candidate explosion. It is not a general-prose memory model.
 *
 * `article-diverse` mixes shared function words with per-document unique
 * tokens so string-interning / unique-type costs can be measured separately.
 */

export const MEMORY_BENCH_SEED = 0x5e1ec7;

const SETTINGS_NOUNS = [
  "wifi", "bluetooth", "display", "sound", "privacy", "network", "keyboard", "mouse",
  "battery", "storage", "notifications", "accounts", "language", "datetime", "accessibility",
  "security", "updates", "apps", "location", "camera", "microphone", "hotspot", "vpn",
  "nfc", "display-brightness", "night-light", "dark-mode", "font-size", "wallpaper",
  "lock-screen", "fingerprint", "passkeys", "autofill", "backup", "sync", "cast",
];
const SETTINGS_TAILS = [
  "settings", "options", "preferences", "configuration", "and accounts", "advanced",
  "for work", "help", "details", "panel",
];
const SETTINGS_BODY = [
  "change", "this", "setting", "on", "your", "device", "to", "control", "how", "apps",
  "use", "network", "access", "and", "privacy", "permissions", "when", "connected",
  "wireless", "accessories", "or", "saved", "accounts", "open", "the", "page", "and",
  "choose", "an", "option", "for", "notifications", "display", "sound", "battery",
];

const ARTICLE_CONTENT = [
  "the", "of", "and", "to", "in", "a", "is", "for", "on", "with", "as", "by", "from",
  "this", "that", "are", "was", "be", "or", "an", "it", "not", "can", "if", "when",
  "search", "index", "document", "query", "title", "body", "token", "lemma", "rank",
  "constraint", "feature", "retriever", "posting", "candidate", "prefix", "version",
  "network", "protocol", "security", "certificate", "encryption", "session", "client",
  "server", "request", "response", "cache", "latency", "throughput", "worker", "heap",
  "memory", "allocation", "string", "array", "set", "map", "object", "function",
  "browser", "runtime", "artifact", "compile", "lexical", "semantic", "graph", "edge",
  "source", "target", "strength", "provenance", "manual", "editorial", "hybrid",
  "wifi", "bluetooth", "nfc", "vpn", "tls", "http", "dns", "tcp", "udp", "ip",
  "vulnerability", "patch", "update", "release", "notes", "guide", "overview", "reference",
  "implementation", "behavior", "deterministic", "explainable", "ranking", "evidence",
  "coverage", "adjacency", "morphology", "equivalence", "dictionary", "synonym",
  "keyboard", "display", "privacy", "location", "camera", "microphone", "notification",
  "account", "password", "passkey", "backup", "restore", "sync", "settings", "option",
];
const ARTICLE_TOPICS = [
  "tls handshake", "virtual private network", "near field communication",
  "wi-fi calling", "bluetooth pairing", "certificate pinning", "dns over https",
  "worker cancellation", "heap snapshot", "inverted index", "constraint ranking",
  "prefix completion", "lexical frequency", "relationship graph", "search explanation",
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function zipfIndex(rng, n, s = 1.15) {
  const x = rng();
  const inv = (1 - x) ** (-1 / (s - 1)) - 1;
  return Math.min(n - 1, Math.max(0, Math.floor(inv) % n));
}

export function generateSettings(n, seed = MEMORY_BENCH_SEED) {
  const rng = mulberry32(seed);
  const docs = new Array(n);
  for (let i = 0; i < n; i++) {
    const noun = SETTINGS_NOUNS[i % SETTINGS_NOUNS.length];
    const tail = i % 5 === 0 ? pick(rng, SETTINGS_TAILS) : SETTINGS_TAILS[0];
    const title = `${noun.replace(/-/g, " ")} ${tail}`.replace(/\s+/g, " ").trim();
    const words = [];
    const len = 12 + Math.floor(rng() * 10);
    for (let w = 0; w < len; w++) words.push(SETTINGS_BODY[(i + w) % SETTINGS_BODY.length]);
    words.push(noun.replace(/-/g, " "));
    docs[i] = { id: `setting-${String(i).padStart(6, "0")}`, title, body: words.join(" ") };
  }
  return docs;
}

export function generateArticle(n, { bodyTokens = 720, seed = MEMORY_BENCH_SEED, diverse = false } = {}) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const docs = new Array(n);
  const vocab = ARTICLE_CONTENT;
  for (let i = 0; i < n; i++) {
    const topic = ARTICLE_TOPICS[i % ARTICLE_TOPICS.length];
    const titleExtra = [];
    const tlen = 4 + Math.floor(rng() * 5);
    for (let t = 0; t < tlen; t++) titleExtra.push(vocab[zipfIndex(rng, vocab.length)]);
    const title = `${topic} ${titleExtra.join(" ")}`;
    const words = [];
    const len = bodyTokens + Math.floor(rng() * 80) - 40;
    for (let w = 0; w < len; w++) {
      if (diverse && w % 9 === 0) {
        words.push(`u${i}_${w}`);
      } else {
        words.push(vocab[zipfIndex(rng, vocab.length)]);
      }
      if (w % 80 === 0) words.push(topic.split(" ")[0]);
    }
    docs[i] = { id: `article-${String(i).padStart(6, "0")}`, title, body: words.join(" ") };
  }
  return docs;
}

export function generateCorpus(shape, n, opts = {}) {
  if (shape === "settings") return generateSettings(n, opts.seed);
  if (shape === "article") return generateArticle(n, opts);
  if (shape === "article-diverse") return generateArticle(n, { ...opts, diverse: true });
  throw new Error(`unknown corpus shape ${JSON.stringify(shape)}`);
}

export function corpusStats(docs) {
  let title = 0;
  let body = 0;
  for (const d of docs) {
    title += d.title.length;
    body += d.body.length;
  }
  return {
    n: docs.length,
    titleCharsMean: docs.length ? +(title / docs.length).toFixed(1) : 0,
    bodyCharsMean: docs.length ? +(body / docs.length).toFixed(1) : 0,
  };
}
