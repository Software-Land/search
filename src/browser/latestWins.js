/**
 * Latest-wins scheduler: at most one running job and one pending job.
 * Intermediate queries are discarded, never queued as FIFO.
 *
 * generation increments as soon as the caller observes a newer query, so a
 * result that completes after the input changed cannot publish.
 */

import { isAbortError } from "../cancel.js";

/**
 * @param {import("./types.js").LatestWinsOptions} [options]
 */
export function createLatestWinsSession({ search, onResult, onClear, onError } = {}) {
  let generation = 0;
  /** @type {import("./types.js").RunningJob | null} */
  let running = null;
  /** @type {import("./types.js").PendingJob | null} */
  let pending = null;
  let disposed = false;
  const stats = {
    submitted: 0,
    executed: 0,
    cancelled: 0,
    coalesced: 0,
    published: 0,
    cleared: 0,
  };

  function currentGeneration() {
    return generation;
  }

  /** @param {unknown} query @param {Record<string, unknown>} [options] */
  function setQuery(query, options = {}) {
    if (disposed) return generation;
    generation += 1;
    const gen = generation;
    stats.submitted += 1;
    const q = String(query ?? "");

    if (!q.trim()) {
      pending = null;
      if (running) {
        stats.cancelled += 1;
        running.abort();
        running = null;
      }
      stats.cleared += 1;
      onClear?.({ generation: gen, query: q });
      return gen;
    }

    if (pending) stats.coalesced += 1;
    pending = { query: q, options, generation: gen };
    if (running) {
      stats.cancelled += 1;
      running.abort();
    } else {
      kick();
    }
    return gen;
  }

  async function kick() {
    while (!disposed && pending) {
      const job = pending;
      pending = null;
      const ac = new AbortController();
      running = {
        generation: job.generation,
        abort() {
          ac.abort();
        },
      };
      stats.executed += 1;
      try {
        if (typeof search !== "function") continue;
        const result = await search(job.query, {
          ...job.options,
          signal: ac.signal,
          generation: job.generation,
        });
        if (!disposed && job.generation === generation) {
          stats.published += 1;
          onResult?.({
            generation: job.generation,
            query: job.query,
            result,
          });
        }
      } catch (err) {
        if (isAbortError(err)) {
          // stale; continue to pending if any
        } else if (!disposed && job.generation === generation) {
          onError?.({ generation: job.generation, query: job.query, error: err });
        }
      } finally {
        if (running && running.generation === job.generation) running = null;
      }
    }
  }

  function dispose() {
    disposed = true;
    generation += 1;
    pending = null;
    if (running) {
      stats.cancelled += 1;
      running.abort();
      running = null;
    }
  }

  return {
    setQuery,
    dispose,
    currentGeneration,
    stats: () => ({ ...stats }),
    get running() {
      return running ? { generation: running.generation } : null;
    },
    get pending() {
      return pending ? { generation: pending.generation, query: pending.query } : null;
    },
    get disposed() {
      return disposed;
    },
  };
}
