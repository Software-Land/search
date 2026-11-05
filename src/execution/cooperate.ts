/**
 * Internal cooperative scheduling for asynchronous search.
 *
 * A slice yields with setTimeout so timer callbacks and Worker messages can
 * run. An already-resolved Promise, queueMicrotask, or process.nextTick does
 * not. Synchronous search does not use this scheduler.
 *
 * The budget is not a deadline. The current slice, a synchronous callback,
 * and any indivisible JavaScript operation finish before the next check.
 * Cancellation stays cooperative.
 */

import { throwIfAborted } from "../cancel.js";

/** Posting rows, documents, or constraint pairs between task yields. */
export const COOPERATE_UNIT_BUDGET = 512;

/**
 * Wall-clock slice. Sampled on checkpoint calls, not once per row.
 * A search that finishes inside one slice does not return to the event loop
 * until that slice ends.
 */
export const COOPERATE_TIME_BUDGET_MS = 12;

const TIME_CHECK_STRIDE = 4;

export type Cooperation = {
  sliceUnits: number;
  completedUnits: number;
  sliceStart: number;
  checks: number;
};

/** Attached to internal option bags. Not a public search option. */
export const COOPERATION: unique symbol = Symbol("search.cooperation");

export function createCooperation(): Cooperation {
  return {
    sliceUnits: 0,
    completedUnits: 0,
    sliceStart: nowMs(),
    checks: 0,
  };
}

export function readCooperation(options: object | null | undefined): Cooperation | null {
  if (!options) return null;
  const value = (options as { [COOPERATION]?: Cooperation })[COOPERATION];
  if (!value || typeof value !== "object") return null;
  return value;
}

export function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value) && typeof (value as Promise<T>).then === "function";
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** One turn of the task queue. Lets timers and Worker messages run. */
export function yieldToTasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Count `weight` units of work already completed at this checkpoint.
 * Returns a promise only when the slice budget is exhausted. Callers must
 * await that promise and must not await a void return: awaiting every
 * checkpoint would schedule a microtask per batch.
 *
 * `weight` 0 only rechecks the clock after earlier work. A checkpoint with
 * no accumulated units does not yield, so a search still does a slice of
 * work before the first task yield.
 */
export function checkpoint(
  coop: Cooperation | null | undefined,
  signal?: AbortSignal | null,
  weight = 1
): Promise<void> | void {
  throwIfAborted(signal);
  if (!coop) return;
  if (weight > 0) {
    coop.completedUnits += weight;
    coop.sliceUnits += weight;
  }
  coop.checks += 1;
  const sampleTime = coop.checks % TIME_CHECK_STRIDE === 0;
  const timeDue =
    coop.completedUnits > 0 &&
    sampleTime &&
    nowMs() - coop.sliceStart >= COOPERATE_TIME_BUDGET_MS;
  if (coop.sliceUnits < COOPERATE_UNIT_BUDGET && !timeDue) return;
  if (coop.completedUnits <= 0) return;
  return yieldToTasks().then(() => {
    throwIfAborted(signal);
    coop.sliceUnits = 0;
    coop.sliceStart = nowMs();
  });
}
