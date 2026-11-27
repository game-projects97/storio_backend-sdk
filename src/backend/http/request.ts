import { BackendError } from "./error.ts";

export type HttpRequest = {
  method: string;
  path: string;
  body: string | undefined;
  generation: AbortSignal;
  caller?: AbortSignal;
  token?: string;
  onUnauthorized?: () => void;
};

const networkFailures = new WeakSet<TypeError>();

export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && networkFailures.has(error);
}

export function createRequest(config: {
  baseUrl: string;
  clientVersion: string;
  timeoutMs: number;
}) {
  const { baseUrl, clientVersion, timeoutMs } = config;

  return async function request<T>({
    method,
    path,
    body,
    generation,
    caller,
    token,
    onUnauthorized,
  }: HttpRequest): Promise<T> {
    const controller = new AbortController();
    const signals = caller ? [generation, caller] : [generation];
    const listeners = signals.map((signal) => {
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return abort;
    });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("request deadline exceeded", "TimeoutError"),
        ),
      timeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      const response = await fetch(baseUrl + path, {
        method,
        credentials: "omit",
        mode: baseUrl.startsWith("http") ? undefined : "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Client-Version": clientVersion,
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        body,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        controller.signal.throwIfAborted();
        if (response.status === 401) onUnauthorized?.();
        throw new BackendError(
          response.status,
          problem?.code ?? "request_failed",
        );
      }
      const data = response.status === 204 ? undefined : await response.json();
      controller.signal.throwIfAborted();
      return data as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        controller.signal.throwIfAborted();
        throw new Error("invalid_response");
      }
      if (error instanceof TypeError) {
        controller.signal.throwIfAborted();
        networkFailures.add(error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signals.forEach((signal, index) =>
        signal.removeEventListener("abort", listeners[index]),
      );
    }
  };
}
