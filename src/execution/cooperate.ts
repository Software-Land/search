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
  yields: number;
  sliceStart: number;
  checks: number;
  stage: string;
  stageUnits: number;
};

export type CooperationYield = {
  completedUnits: number;
  yields: number;
  stage: string;
  stageUnits: number;
};

/** Attached to internal option bags. Not a public search option. */
export const COOPERATION: unique symbol = Symbol("search.cooperation");

type Probe = (info: CooperationYield) => void;
let probe: Probe | null = null;

export function createCooperation(): Cooperation {
  return {
    sliceUnits: 0,
    completedUnits: 0,
    yields: 0,
    sliceStart: nowMs(),
    checks: 0,
    stage: "",
    stageUnits: 0,
  };
}

/** Name the phase whose checkpoints should report `stageUnits`. */
export function enterCooperationStage(coop: Cooperation | null | undefined, stage: string): void {
  if (!coop || coop.stage === stage) return;
  coop.stage = stage;
  coop.stageUnits = 0;
}

type PublishHold = () => Promise<void> | void;
let beforePackedPublish: PublishHold | null = null;

/**
 * Test hook. Holds the packed path after ranking resolves and before
 * success is published. Production leaves this unset.
 */
export function setBeforePackedPublish(next: PublishHold | null): void {
  beforePackedPublish = next;
}

export function takeBeforePackedPublish(): Promise<void> | void {
  const hook = beforePackedPublish;
  if (!hook) return;
  beforePackedPublish = null;
  return hook();
}

export function readCooperation(options: object | null | undefined): Cooperation | null {
  if (!options) return null;
  const value = (options as { [COOPERATION]?: Cooperation })[COOPERATION];
  if (!value || typeof value !== "object") return null;
  return value;
}

/**
 * Test instrumentation. Production leaves this unset. Not a public API and
 * not part of the Worker protocol.
 */
export function setCooperationProbe(next: Probe | null): void {
  probe = next;
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
    coop.stageUnits += weight;
  }
  coop.checks += 1;
  const sampleTime = coop.checks % TIME_CHECK_STRIDE === 0;
  const timeDue =
    coop.completedUnits > 0 &&
    sampleTime &&
    nowMs() - coop.sliceStart >= COOPERATE_TIME_BUDGET_MS;
  if (coop.sliceUnits < COOPERATE_UNIT_BUDGET && !timeDue) return;
  if (coop.completedUnits <= 0) return;
  probe?.({
    completedUnits: coop.completedUnits,
    yields: coop.yields + 1,
    stage: coop.stage,
    stageUnits: coop.stageUnits,
  });
  return yieldToTasks().then(() => {
    throwIfAborted(signal);
    coop.sliceUnits = 0;
    coop.yields += 1;
    coop.sliceStart = nowMs();
  });
}
