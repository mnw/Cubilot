// A fake clock or fake wait that drives a loop in the code under test must stop after a fixed number of steps. A loop
// that never ends on a fake clock otherwise hangs the run and grows whatever the helper records (agent-column.test.ts
// did before the C5b fix). Passive clock injections (a `now` that only returns a number) need no bound.
export const MAX_FAKE_STEPS = 10_000;

/** Counts the steps of one fake. Call the result at each step: step 10 001 throws a clear error. */
export function stepLimit(label: string, max = MAX_FAKE_STEPS): () => void {
  let n = 0;
  return () => {
    if (++n > max) throw new Error(`fake "${label}" ran more than ${max} steps: the code under test loops without end`);
  };
}

/** A sleep that returns at once and fails the loop that calls it more than `max` times. */
export function boundedSleep(label: string, inner?: (ms: number) => void, max = MAX_FAKE_STEPS): (ms: number) => Promise<void> {
  const step = stepLimit(label, max);
  return async (ms) => {
    step();
    inner?.(ms);
  };
}
