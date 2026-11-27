import { gameScope } from "./http/paths.ts";
import type { Environment } from "./internal/auth/types.ts";

function resolveApiBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith("/")) {
    const origin = "https://storio.invalid";
    const base = new URL(baseUrl, origin);
    if (base.origin === origin && base.pathname === baseUrl) {
      return base.pathname.replace(/\/+$/, "");
    }
  } else {
    const base = new URL(baseUrl);
    if (
      (base.protocol === "http:" || base.protocol === "https:") &&
      base.href === base.origin + "/"
    ) {
      return base.origin + "/api/v1";
    }
  }
  throw new Error(
    "baseUrl must be a same-origin API path or an HTTP origin without credentials",
  );
}

export type BackendOptions = {
  /** 같은 출처의 API 경로(예: /api/v1) 또는 절대 HTTP 오리진을 지정한다. */
  baseUrl: string;
  projectId: string;
  environment: Environment;
  clientVersion: string;
  timeoutMs?: number;
  /** 남은 만료 시간이 이 초 수 이하면 요청을 보낼 때 갱신한다. */
  refreshBeforeSeconds?: number;
};

export function resolveBackendConfig(options: BackendOptions) {
  if (
    !options.projectId ||
    options.projectId === "." ||
    options.projectId === ".."
  ) {
    throw new Error("projectId must be a nonempty path segment");
  }
  if (
    options.environment !== "development" &&
    options.environment !== "production"
  ) {
    throw new Error("environment must be development or production");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be within (0, 120000]");
  }
  const refreshBeforeSeconds = options.refreshBeforeSeconds ?? 60;
  if (!Number.isFinite(refreshBeforeSeconds) || refreshBeforeSeconds < 0) {
    throw new Error("refreshBeforeSeconds must be finite and nonnegative");
  }
  return {
    baseUrl: resolveApiBaseUrl(options.baseUrl),
    scope: gameScope(options.projectId, options.environment),
    clientVersion: options.clientVersion,
    timeoutMs,
    refreshBeforeSeconds,
  };
}
