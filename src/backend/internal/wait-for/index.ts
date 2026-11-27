export function waitFor<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    result
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
