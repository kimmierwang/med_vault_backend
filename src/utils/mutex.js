// Runs async jobs one at a time per key (in this process). Used so two requests never
// reconcile the same pharmacy's alerts at the same moment and create duplicates.
const tails = new Map();

export function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
