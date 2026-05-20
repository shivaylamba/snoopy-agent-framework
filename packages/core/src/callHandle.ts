/**
 * Awaitable handle returned by session.prompt/skill/task/shell.
 * Promise + AbortSignal + abort() — direct Flue parity.
 *
 *   const h = ctx.session.prompt("...", { signal: AbortSignal.timeout(10_000) });
 *   setTimeout(() => h.abort("user cancelled"), 5_000);
 *   const result = await h;     // throws AbortError if cancelled
 */
export interface CallHandle<T> extends PromiseLike<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export class AbortError extends Error {
  override readonly name = "AbortError";
  override readonly cause?: unknown;
  constructor(reason?: unknown) {
    super(typeof reason === "string" ? reason : "aborted");
    this.cause = reason;
  }
}

/**
 * Wrap an async function so it returns a CallHandle. The function receives
 * the merged AbortSignal (its own + any external signal) and is expected
 * to honor it. Calling .abort() rejects the handle with AbortError.
 */
export function makeCallHandle<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): CallHandle<T> {
  const ctrl = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", () => ctrl.abort(externalSignal.reason));
  }
  const promise = (async () => {
    if (ctrl.signal.aborted) throw new AbortError(ctrl.signal.reason);
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) throw new AbortError(ctrl.signal.reason);
      throw err;
    }
  })();

  const handle = {
    then: promise.then.bind(promise),
    catch: (promise as any).catch?.bind(promise),
    finally: (promise as any).finally?.bind(promise),
    signal: ctrl.signal,
    abort: (reason?: unknown) => ctrl.abort(reason),
  } as CallHandle<T>;
  return handle;
}
