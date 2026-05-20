/**
 * Keyed mutex — serializes async operations per key in-process.
 *
 * Pattern from rohitg00/agentmemory's `src/state/keyed-mutex.ts`. Critical
 * for read-modify-write flows on iii state where two concurrent
 * invocations would otherwise race (e.g. two webhook deliveries both
 * appending to `incident:<runId>:timeline`).
 *
 *   await withKeyedLock(`session:${runId}`, async () => {
 *     const prior = await kv.get(scope, key);
 *     const next = { ...prior, ...patch };
 *     await kv.set(scope, key, next);
 *   });
 *
 * For cross-process locking, use iii leases (see `IIILease` if exposed)
 * or move the operation into a single iii function that owns the key.
 */
const locks = new Map<string, Promise<void>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(key, cleanup);
  cleanup.then(() => {
    if (locks.get(key) === cleanup) locks.delete(key);
  });
  return next;
}
