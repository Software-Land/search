/**
 * Compact compiled-document store.
 *
 * Token/lemma/position data stays in global typed arrays. Per-document
 * IndexedDocument views decode through accessors instead of owning Sets,
 * Maps, and duplicate string arrays.
 */
import { DEFAULT_STOP } from "./text.js";
import type { IndexedDocument } from "./types.js";

export const KIND_TITLE = 0;
export const KIND_BODY = 1;
export const KIND_TITLE_LEMMA = 2;
export const KIND_BODY_LEMMA = 3;
export const KIND_INDEPENDENT = 4;
export const KIND_INDEPENDENT_LEMMA = 5;
export const KIND_NONSTOP_TITLE = 6;

export type TokenKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const EMPTY_U32 = new Uint32Array(0);
const EMPTY_STRINGS: string[] = [];

export type CompactDocumentStore = {
  n: number;
  strings: string[];
  idOf: Map<string, number>;
  lemmaOf: Uint32Array;
  titleIds: Uint32Array;
  titleOff: Uint32Array;
  bodyIds: Uint32Array;
  bodyOff: Uint32Array;
  ids: string[];
  titles: string[];
  normalizedTitles: string[];
  firstToken: string[];
  versionForms: string[][];
  dottedSpans: string[][];
  dottedOff: Uint32Array;
  dottedIdx: Uint32Array;
  lexicalFrequency: Array<Record<string, number> | null>;
  titleTokenSet: Set<string>;
  surfaceVocabulary: Set<string>;
};

export function internTerm(strings: string[], idOf: Map<string, number>, term: string) {
  let id = idOf.get(term);
  if (id !== undefined) return id;
  id = strings.length;
  strings.push(term);
  idOf.set(term, id);
  return id;
}

function spanLength(off: Uint32Array, ordinal: number) {
  return off[ordinal + 1] - off[ordinal];
}

function dottedHas(store: CompactDocumentStore, ordinal: number, index: number) {
  const start = store.dottedOff[ordinal];
  const end = store.dottedOff[ordinal + 1];
  for (let i = start; i < end; i++) {
    if (store.dottedIdx[i] === index) return true;
  }
  return false;
}

export function tokenIdAt(store: CompactDocumentStore, ordinal: number, kind: TokenKind, i: number) {
  if (kind === KIND_TITLE || kind === KIND_TITLE_LEMMA) {
    const start = store.titleOff[ordinal];
    const len = store.titleOff[ordinal + 1] - start;
    if (i < 0 || i >= len) return -1;
    const surface = store.titleIds[start + i];
    return kind === KIND_TITLE ? surface : store.lemmaOf[surface];
  }
  if (kind === KIND_BODY || kind === KIND_BODY_LEMMA) {
    const start = store.bodyOff[ordinal];
    const len = store.bodyOff[ordinal + 1] - start;
    if (i < 0 || i >= len) return -1;
    const surface = store.bodyIds[start + i];
    return kind === KIND_BODY ? surface : store.lemmaOf[surface];
  }
  if (kind === KIND_INDEPENDENT || kind === KIND_INDEPENDENT_LEMMA) {
    let seen = 0;
    const start = store.titleOff[ordinal];
    const len = store.titleOff[ordinal + 1] - start;
    for (let p = 0; p < len; p++) {
      if (dottedHas(store, ordinal, p)) continue;
      if (seen === i) {
        const surface = store.titleIds[start + p];
        return kind === KIND_INDEPENDENT ? surface : store.lemmaOf[surface];
      }
      seen += 1;
    }
    return -1;
  }
  let seen = 0;
  const start = store.titleOff[ordinal];
  const len = store.titleOff[ordinal + 1] - start;
  for (let p = 0; p < len; p++) {
    const surface = store.titleIds[start + p];
    if (DEFAULT_STOP.has(store.strings[surface])) continue;
    if (seen === i) return surface;
    seen += 1;
  }
  return -1;
}

export function tokenSeqLength(store: CompactDocumentStore, ordinal: number, kind: TokenKind) {
  if (kind === KIND_TITLE || kind === KIND_TITLE_LEMMA) return spanLength(store.titleOff, ordinal);
  if (kind === KIND_BODY || kind === KIND_BODY_LEMMA) return spanLength(store.bodyOff, ordinal);
  if (kind === KIND_INDEPENDENT || kind === KIND_INDEPENDENT_LEMMA) {
    const start = store.titleOff[ordinal];
    const len = store.titleOff[ordinal + 1] - start;
    let n = 0;
    for (let p = 0; p < len; p++) {
      if (!dottedHas(store, ordinal, p)) n += 1;
    }
    return n;
  }
  const start = store.titleOff[ordinal];
  const len = store.titleOff[ordinal + 1] - start;
  let n = 0;
  for (let p = 0; p < len; p++) {
    if (!DEFAULT_STOP.has(store.strings[store.titleIds[start + p]])) n += 1;
  }
  return n;
}

export function tokenAt(store: CompactDocumentStore, ordinal: number, kind: TokenKind, i: number) {
  const id = tokenIdAt(store, ordinal, kind, i);
  return id < 0 ? undefined : store.strings[id];
}

function scanIds(ids: Uint32Array, start: number, end: number, want: number) {
  for (let i = start; i < end; i++) {
    if (ids[i] === want) return true;
  }
  return false;
}

function scanLemmas(
  ids: Uint32Array,
  lemmaOf: Uint32Array,
  start: number,
  end: number,
  want: number
) {
  for (let i = start; i < end; i++) {
    if (lemmaOf[ids[i]] === want) return true;
  }
  return false;
}

export function asCompactStore(doc: unknown): CompactDocumentStore | null {
  if (!doc || typeof doc !== "object") return null;
  const store = (doc as { _store?: CompactDocumentStore })._store;
  return store && store.titleIds instanceof Uint32Array ? store : null;
}

export function compactOrdinal(doc: unknown) {
  if (!doc || typeof doc !== "object") return 0;
  const ordinal = (doc as { _ordinal?: number })._ordinal;
  return typeof ordinal === "number" ? ordinal : 0;
}

export function compactLemmasDiffer(store: CompactDocumentStore, ordinal: number, field: "title" | "body") {
  const ids = field === "title" ? store.titleIds : store.bodyIds;
  const off = field === "title" ? store.titleOff : store.bodyOff;
  const start = off[ordinal];
  const end = off[ordinal + 1];
  const lemmaOf = store.lemmaOf;
  for (let i = start; i < end; i++) {
    if (lemmaOf[ids[i]] !== ids[i]) return true;
  }
  return false;
}

/**
 * Exact phrase-adjacency scan over packed surface or lemma ids.
 * `match` is the existing tokenAdjacencyMatch predicate.
 */
export function compactAdjacentTokens(
  store: CompactDocumentStore,
  ordinal: number,
  kind: TokenKind,
  queryToks: string[],
  match: (qt: string, tt: string | undefined) => boolean
) {
  if (queryToks.length < 2) return false;
  const title = kind === KIND_TITLE || kind === KIND_TITLE_LEMMA;
  const asLemma = kind === KIND_TITLE_LEMMA || kind === KIND_BODY_LEMMA;
  const ids = title ? store.titleIds : store.bodyIds;
  const off = title ? store.titleOff : store.bodyOff;
  const start = off[ordinal];
  const end = off[ordinal + 1];
  const len = end - start;
  const m = queryToks.length;
  if (len < m) return false;
  const last = len - m;
  const lemmaOf = store.lemmaOf;
  const strings = store.strings;
  for (let i = 0; i <= last; i++) {
    const first = asLemma ? lemmaOf[ids[start + i]] : ids[start + i];
    if (!match(queryToks[0], strings[first])) continue;
    let ok = true;
    for (let j = 1; j < m; j++) {
      const id = asLemma ? lemmaOf[ids[start + i + j]] : ids[start + i + j];
      if (!match(queryToks[j], strings[id])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function compactHasIndependentTitleForm(store: CompactDocumentStore, ordinal: number, form: string) {
  if (!form) return false;
  const want = store.idOf.get(form);
  const start = store.titleOff[ordinal];
  const end = store.titleOff[ordinal + 1];
  const ids = store.titleIds;
  const lemmaOf = store.lemmaOf;
  const strings = store.strings;
  for (let p = 0; p < end - start; p++) {
    if (dottedHas(store, ordinal, p)) continue;
    const surface = ids[start + p];
    if (want !== undefined) {
      if (surface === want || lemmaOf[surface] === want) return true;
      continue;
    }
    if (strings[surface] === form || strings[lemmaOf[surface]] === form) return true;
  }
  return false;
}

export function compactTitleHasPrefixForm(
  store: CompactDocumentStore,
  ordinal: number,
  form: string,
  allowPrefix: (queryTok: string, titleTok: string) => boolean
) {
  const start = store.titleOff[ordinal];
  const end = store.titleOff[ordinal + 1];
  const ids = store.titleIds;
  const strings = store.strings;
  for (let i = start; i < end; i++) {
    if (allowPrefix(form, strings[ids[i]])) return true;
  }
  return false;
}

export function compactTitleHasLemma(store: CompactDocumentStore, ordinal: number, form: string) {
  const want = store.idOf.get(form);
  if (want === undefined) return false;
  const start = store.titleOff[ordinal];
  const end = store.titleOff[ordinal + 1];
  const ids = store.titleIds;
  const lemmaOf = store.lemmaOf;
  for (let i = start; i < end; i++) {
    if (lemmaOf[ids[i]] === want) return true;
  }
  return false;
}

export function compactBodyMatchesConcept(store: CompactDocumentStore, ordinal: number, forms: string[]) {
  if (!forms.length) return false;
  const start = store.bodyOff[ordinal];
  const end = store.bodyOff[ordinal + 1];
  const ids = store.bodyIds;
  const lemmaOf = store.lemmaOf;
  const strings = store.strings;
  const idOf = store.idOf;
  const exact = new Set<number>();
  const prefixes: string[] = [];
  for (const form of forms) {
    if (!form || /\s/.test(form)) continue;
    const id = idOf.get(form);
    if (id !== undefined) exact.add(id);
    if (!/^\d+$/.test(form) && form.length >= 3) prefixes.push(form);
  }
  for (let i = start; i < end; i++) {
    const surface = ids[i];
    if (exact.has(surface) || exact.has(lemmaOf[surface])) return true;
    const tok = strings[surface];
    if (/^\d+$/.test(tok)) continue;
    for (let p = 0; p < prefixes.length; p++) {
      if (tok.startsWith(prefixes[p])) return true;
    }
  }
  return false;
}

export function fieldHasTerm(store: CompactDocumentStore, ordinal: number, kind: TokenKind, term: string) {
  const want = store.idOf.get(term);
  if (want === undefined) return false;
  if (kind === KIND_TITLE) {
    return scanIds(store.titleIds, store.titleOff[ordinal], store.titleOff[ordinal + 1], want);
  }
  if (kind === KIND_BODY) {
    return scanIds(store.bodyIds, store.bodyOff[ordinal], store.bodyOff[ordinal + 1], want);
  }
  if (kind === KIND_TITLE_LEMMA) {
    return scanLemmas(store.titleIds, store.lemmaOf, store.titleOff[ordinal], store.titleOff[ordinal + 1], want);
  }
  if (kind === KIND_BODY_LEMMA) {
    return scanLemmas(store.bodyIds, store.lemmaOf, store.bodyOff[ordinal], store.bodyOff[ordinal + 1], want);
  }
  const len = tokenSeqLength(store, ordinal, kind);
  for (let i = 0; i < len; i++) {
    if (tokenIdAt(store, ordinal, kind, i) === want) return true;
  }
  return false;
}

const packedProto: Record<string | symbol, unknown> = {
  at(this: PackedTokens, i: number) {
    return tokenAt(this._store, this._ordinal, this._kind, i | 0);
  },
  some(this: PackedTokens, fn: (value: string, i: number) => boolean) {
    const n = this.length;
    for (let i = 0; i < n; i++) {
      if (fn(tokenAt(this._store, this._ordinal, this._kind, i) as string, i)) return true;
    }
    return false;
  },
  map(this: PackedTokens, fn: (value: string, i: number) => unknown) {
    const n = this.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fn(tokenAt(this._store, this._ordinal, this._kind, i) as string, i);
    return out;
  },
  filter(this: PackedTokens, fn: (value: string, i: number) => boolean) {
    const n = this.length;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const value = tokenAt(this._store, this._ordinal, this._kind, i) as string;
      if (fn(value, i)) out.push(value);
    }
    return out;
  },
  join(this: PackedTokens, sep = ",") {
    const n = this.length;
    if (!n) return "";
    let out = tokenAt(this._store, this._ordinal, this._kind, 0) as string;
    for (let i = 1; i < n; i++) out += sep + (tokenAt(this._store, this._ordinal, this._kind, i) as string);
    return out;
  },
  find(this: PackedTokens, fn: (value: string, i: number) => boolean) {
    const n = this.length;
    for (let i = 0; i < n; i++) {
      const value = tokenAt(this._store, this._ordinal, this._kind, i) as string;
      if (fn(value, i)) return value;
    }
    return undefined;
  },
  includes(this: PackedTokens, value: string) {
    return fieldHasTerm(this._store, this._ordinal, this._kind, value);
  },
  toArray(this: PackedTokens) {
    const n = this.length;
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = tokenAt(this._store, this._ordinal, this._kind, i) as string;
    return out;
  },
};

packedProto[Symbol.iterator] = function* packedIter(this: PackedTokens) {
  const n = this.length;
  for (let i = 0; i < n; i++) yield tokenAt(this._store, this._ordinal, this._kind, i) as string;
};

type PackedTokens = {
  _store: CompactDocumentStore;
  _ordinal: number;
  _kind: TokenKind;
  length: number;
  at(i: number): string | undefined;
  some(fn: (value: string, i: number) => boolean): boolean;
  map(fn: (value: string, i: number) => unknown): unknown[];
  filter(fn: (value: string, i: number) => boolean): string[];
  join(sep?: string): string;
  find(fn: (value: string, i: number) => boolean): string | undefined;
  includes(value: string): boolean;
  toArray(): string[];
  [index: number]: string;
};

const tokenHandler: ProxyHandler<PackedTokens> = {
  get(target, prop, receiver) {
    if (prop === "length") return target.length;
    if (prop === "constructor") return Array;
    if (typeof prop === "string") {
      const i = +prop;
      if (prop === String(i) && i >= 0 && i < target.length) {
        return tokenAt(target._store, target._ordinal, target._kind, i);
      }
    }
    const owned = packedProto[prop];
    if (owned !== undefined) {
      return typeof owned === "function" ? owned.bind(target) : owned;
    }
    return Reflect.get(target, prop, receiver);
  },
  getPrototypeOf() {
    return Array.prototype;
  },
  has(target, prop) {
    if (prop === "length" || packedProto[prop] !== undefined) return true;
    if (typeof prop === "string") {
      const i = +prop;
      return prop === String(i) && i >= 0 && i < target.length;
    }
    return false;
  },
  ownKeys(target) {
    const keys: string[] = ["length"];
    for (let i = 0; i < target.length; i++) keys.push(String(i));
    return keys;
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === "length") {
      return { configurable: false, enumerable: false, writable: true, value: target.length };
    }
    if (typeof prop === "string") {
      const i = +prop;
      if (prop === String(i) && i >= 0 && i < target.length) {
        return {
          configurable: true,
          enumerable: true,
          value: tokenAt(target._store, target._ordinal, target._kind, i),
        };
      }
    }
    return undefined;
  },
};

export function packedTokens(store: CompactDocumentStore, ordinal: number, kind: TokenKind): PackedTokens {
  const target = [] as unknown as PackedTokens;
  target._store = store;
  target._ordinal = ordinal;
  target._kind = kind;
  target.length = tokenSeqLength(store, ordinal, kind);
  return new Proxy(target, tokenHandler);
}

class PackedSet {
  constructor(
    private store: CompactDocumentStore,
    private ordinal: number,
    private kind: TokenKind
  ) {}
  has(term: string) {
    return fieldHasTerm(this.store, this.ordinal, this.kind, term);
  }
}

class PackedIndexSet {
  constructor(
    private store: CompactDocumentStore,
    private ordinal: number
  ) {}
  has(index: number) {
    return dottedHas(this.store, this.ordinal, index);
  }
  [Symbol.iterator]() {
    const store = this.store;
    const start = store.dottedOff[this.ordinal];
    const end = store.dottedOff[this.ordinal + 1];
    let i = start;
    return {
      next() {
        if (i >= end) return { done: true as const, value: undefined };
        return { done: false as const, value: store.dottedIdx[i++] };
      },
    };
  }
}

class PackedPosMap {
  constructor(
    private store: CompactDocumentStore,
    private ordinal: number,
    private kind: TokenKind
  ) {}
  get(term: string) {
    const want = this.store.idOf.get(term);
    if (want === undefined) return undefined;
    const store = this.store;
    const kind = this.kind;
    const ordinal = this.ordinal;
    const out: number[] = [];
    if (kind === KIND_TITLE || kind === KIND_TITLE_LEMMA) {
      const start = store.titleOff[ordinal];
      const end = store.titleOff[ordinal + 1];
      const lemma = kind === KIND_TITLE_LEMMA;
      for (let i = start; i < end; i++) {
        const id = lemma ? store.lemmaOf[store.titleIds[i]] : store.titleIds[i];
        if (id === want) out.push(i - start);
      }
    } else if (kind === KIND_BODY || kind === KIND_BODY_LEMMA) {
      const start = store.bodyOff[ordinal];
      const end = store.bodyOff[ordinal + 1];
      const lemma = kind === KIND_BODY_LEMMA;
      for (let i = start; i < end; i++) {
        const id = lemma ? store.lemmaOf[store.bodyIds[i]] : store.bodyIds[i];
        if (id === want) out.push(i - start);
      }
    } else {
      const len = tokenSeqLength(store, ordinal, kind);
      for (let i = 0; i < len; i++) {
        if (tokenIdAt(store, ordinal, kind, i) === want) out.push(i);
      }
    }
    return out.length ? out : undefined;
  }
}

export class CompactIndexedDocument {
  readonly id: string;
  readonly title: string;
  readonly body = "";
  readonly firstToken: string;
  readonly normalizedTitle: string;
  readonly versionCompactForms: string[];
  readonly dottedSpans: string[];
  readonly lexicalFrequency: Record<string, number> | null;
  readonly _ordinal: number;
  readonly _store: CompactDocumentStore;
  private _titleTokens: PackedTokens | null = null;
  private _bodyTokens: PackedTokens | null = null;
  private _titleLemmas: PackedTokens | null = null;
  private _bodyLemmas: PackedTokens | null = null;
  private _nonStopTitle: PackedTokens | null = null;
  private _independentTitleTokens: PackedTokens | null = null;
  private _titleTokenSet: PackedSet | null = null;
  private _bodyTokenSet: PackedSet | null = null;
  private _titleLemmaSet: PackedSet | null = null;
  private _bodyLemmaSet: PackedSet | null = null;
  private _independentTitleTokenSet: PackedSet | null = null;
  private _independentTitleLemmaSet: PackedSet | null = null;
  private _dottedSpanComponentIndexes: PackedIndexSet | null = null;
  private _bodyTokenPositions: PackedPosMap | null = null;
  private _bodyLemmaPositions: PackedPosMap | null = null;
  private _raw: { id: string; title: string; body: string } | null = null;

  constructor(store: CompactDocumentStore, ordinal: number) {
    this._store = store;
    this._ordinal = ordinal;
    this.id = store.ids[ordinal];
    this.title = store.titles[ordinal];
    this.firstToken = store.firstToken[ordinal];
    this.normalizedTitle = store.normalizedTitles[ordinal];
    this.versionCompactForms = store.versionForms[ordinal] || EMPTY_STRINGS;
    this.dottedSpans = store.dottedSpans[ordinal] || EMPTY_STRINGS;
    this.lexicalFrequency = store.lexicalFrequency[ordinal];
  }

  get raw() {
    return this._raw || (this._raw = { id: this.id, title: this.title, body: "" });
  }
  get titleTokens() {
    return this._titleTokens || (this._titleTokens = packedTokens(this._store, this._ordinal, KIND_TITLE));
  }
  get bodyTokens() {
    return this._bodyTokens || (this._bodyTokens = packedTokens(this._store, this._ordinal, KIND_BODY));
  }
  get titleLemmas() {
    return this._titleLemmas || (this._titleLemmas = packedTokens(this._store, this._ordinal, KIND_TITLE_LEMMA));
  }
  get bodyLemmas() {
    return this._bodyLemmas || (this._bodyLemmas = packedTokens(this._store, this._ordinal, KIND_BODY_LEMMA));
  }
  get titleTokenSet() {
    return this._titleTokenSet || (this._titleTokenSet = new PackedSet(this._store, this._ordinal, KIND_TITLE));
  }
  get bodyTokenSet() {
    return this._bodyTokenSet || (this._bodyTokenSet = new PackedSet(this._store, this._ordinal, KIND_BODY));
  }
  get titleLemmaSet() {
    return this._titleLemmaSet || (this._titleLemmaSet = new PackedSet(this._store, this._ordinal, KIND_TITLE_LEMMA));
  }
  get bodyLemmaSet() {
    return this._bodyLemmaSet || (this._bodyLemmaSet = new PackedSet(this._store, this._ordinal, KIND_BODY_LEMMA));
  }
  get nonStopTitle() {
    return this._nonStopTitle || (this._nonStopTitle = packedTokens(this._store, this._ordinal, KIND_NONSTOP_TITLE));
  }
  get independentTitleTokens() {
    return (
      this._independentTitleTokens ||
      (this._independentTitleTokens = packedTokens(this._store, this._ordinal, KIND_INDEPENDENT))
    );
  }
  get independentTitleTokenSet() {
    return (
      this._independentTitleTokenSet ||
      (this._independentTitleTokenSet = new PackedSet(this._store, this._ordinal, KIND_INDEPENDENT))
    );
  }
  get independentTitleLemmaSet() {
    return (
      this._independentTitleLemmaSet ||
      (this._independentTitleLemmaSet = new PackedSet(this._store, this._ordinal, KIND_INDEPENDENT_LEMMA))
    );
  }
  get dottedSpanComponentIndexes() {
    return (
      this._dottedSpanComponentIndexes ||
      (this._dottedSpanComponentIndexes = new PackedIndexSet(this._store, this._ordinal))
    );
  }
  get bodyTokenPositions() {
    return (
      this._bodyTokenPositions ||
      (this._bodyTokenPositions = new PackedPosMap(this._store, this._ordinal, KIND_BODY))
    );
  }
  get bodyLemmaPositions() {
    return (
      this._bodyLemmaPositions ||
      (this._bodyLemmaPositions = new PackedPosMap(this._store, this._ordinal, KIND_BODY_LEMMA))
    );
  }
}

export function compactDocuments(store: CompactDocumentStore): IndexedDocument[] {
  const documents = new Array<IndexedDocument>(store.n);
  for (let i = 0; i < store.n; i++) {
    documents[i] = new CompactIndexedDocument(store, i) as unknown as IndexedDocument;
  }
  return documents;
}

export function emptyCompactStore(n: number): CompactDocumentStore {
  const titleOff = new Uint32Array(n + 1);
  const bodyOff = new Uint32Array(n + 1);
  const dottedOff = new Uint32Array(n + 1);
  return {
    n,
    strings: [""],
    idOf: new Map([["", 0]]),
    lemmaOf: new Uint32Array([0]),
    titleIds: EMPTY_U32,
    titleOff,
    bodyIds: EMPTY_U32,
    bodyOff,
    ids: new Array(n),
    titles: new Array(n),
    normalizedTitles: new Array(n),
    firstToken: new Array(n),
    versionForms: new Array(n),
    dottedSpans: new Array(n),
    dottedOff,
    dottedIdx: EMPTY_U32,
    lexicalFrequency: new Array(n),
    titleTokenSet: new Set(),
    surfaceVocabulary: new Set(),
  };
}
