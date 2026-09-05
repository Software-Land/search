/**
 * Deterministic binary max-heap. `better(a, b)` is true when `a` should be
 * extracted before `b`. Ties must be broken by the caller (unique ids).
 */

export class BinaryMaxHeap<T> {
  private readonly data: T[] = [];

  constructor(private readonly better: (a: T, b: T) => boolean) {}

  get size() {
    return this.data.length;
  }

  push(item: T) {
    this.data.push(item);
    this.up(this.data.length - 1);
  }

  pop(): T {
    const data = this.data;
    const top = data[0];
    const last = data.pop();
    if (data.length && last !== undefined) {
      data[0] = last;
      this.down(0);
    }
    return top;
  }

  private up(i: number) {
    const data = this.data;
    const { better } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!better(data[i], data[p])) break;
      const tmp = data[i];
      data[i] = data[p];
      data[p] = tmp;
      i = p;
    }
  }

  private down(i: number) {
    const data = this.data;
    const { better } = this;
    const n = data.length;
    while (true) {
      let best = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && better(data[l], data[best])) best = l;
      if (r < n && better(data[r], data[best])) best = r;
      if (best === i) break;
      const tmp = data[i];
      data[i] = data[best];
      data[best] = tmp;
      i = best;
    }
  }
}

export function scoreThenIdBetter(
  scoreA: number,
  idA: string,
  scoreB: number,
  idB: string
) {
  if (scoreA !== scoreB) return scoreA > scoreB;
  return idA < idB;
}
