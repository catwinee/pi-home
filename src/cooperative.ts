import { setImmediate as nextTurn } from "node:timers/promises";

/** The same generator serves synchronous callers and time-sliced background work. */
export function runSync<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Yield to real I/O/render turns, not just the Promise microtask queue.
 * A slice is a soft budget: individual JSON.parse/stringify/sort calls cannot be preempted.
 */
export async function runCooperatively<T>(steps: Generator<void, T>, signal?: AbortSignal): Promise<T> {
  try {
    signal?.throwIfAborted();
    await nextTurn();
    let deadline = performance.now() + 6;
    for (;;) {
      signal?.throwIfAborted();
      const step = steps.next();
      if (step.done) return step.value;
      if (performance.now() >= deadline) {
        await nextTurn();
        deadline = performance.now() + 6;
      }
    }
  } finally { steps.return(undefined as T); }
}
