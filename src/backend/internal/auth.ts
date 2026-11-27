import type {
  Bootstrap,
  CustomCredentials,
  CustomLinkResult,
  CustomSession,
  GuestCredentials,
  Session,
  StartupResult,
} from "../../types.ts";
import type { resolveBackendConfig } from "../config.ts";
import { BackendError } from "../http/error.ts";
import { gameScope } from "../http/paths.ts";
import {
  isNetworkFailure,
  type createRequest,
  type HttpRequest,
} from "../http/request.ts";
import {
  parseBootstrap,
  parseCustomLink,
  parseCustomSession,
  parseGuest,
  parseSession,
} from "../http/responses.ts";
import { waitFor } from "./wait-for.ts";

export type AuthenticatedRequest = <T>(
  method: string,
  path: string,
  body: string | undefined,
  caller?: AbortSignal,
) => Promise<T>;

type SessionMode = "current" | "refresh" | "preserve-on-401";

export type GetGuestCredentials = (
  signal?: AbortSignal,
) => Promise<GuestCredentials>;

type AccountSessionPath = "/sessions" | "/accounts/custom" | "/sessions/custom";

type StartupFlight = {
  getCredentials: GetGuestCredentials;
  controller: AbortController;
  result: Promise<StartupResult>;
  waiters: number;
};

function blockedStartup(policy: Bootstrap): StartupResult | undefined {
  if (policy.maintenance_active) return { status: "maintenance", policy };
  if (policy.version_status === "required") {
    return { status: "update_required", policy };
  }
}

function temporaryStartupFailure(error: unknown): boolean {
  if (error instanceof BackendError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    isNetworkFailure(error) ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

export class Auth {
  private lifecycle = new AbortController();
  private unauthenticatedRequests = new AbortController();
  private token: string | undefined;
  private expiresAt: number | undefined;
  private refreshFlight: Promise<Session> | undefined;
  private accountAttempt: AbortController | undefined;
  private startupFlight: StartupFlight | undefined;
  private startedGuest:
    { getCredentials: GetGuestCredentials; policy: Bootstrap } | undefined;
  private closed = false;

  constructor(
    private readonly config: Pick<
      ReturnType<typeof resolveBackendConfig>,
      "scope" | "clientVersion" | "refreshBeforeSeconds"
    >,
    private readonly transport: ReturnType<typeof createRequest>,
    private readonly clearPendingSaves: () => void,
  ) {}

  get sessionSignal(): AbortSignal {
    return this.lifecycle.signal;
  }

  readonly requestAuthenticated: AuthenticatedRequest = (
    method,
    path,
    body,
    caller,
  ) => this.request(method, path, body, true, caller);

  async startGuestSession(
    getCredentials: GetGuestCredentials,
    signal?: AbortSignal,
  ): Promise<StartupResult> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("client_closed");
    if (
      this.startedGuest?.getCredentials === getCredentials &&
      this.token &&
      this.expiresAt !== undefined &&
      this.expiresAt > Date.now() / 1000
    ) {
      return {
        status: "ready",
        session: { token: this.token, expires_at: this.expiresAt },
        policy: { ...this.startedGuest.policy },
      };
    }

    let flight = this.startupFlight;
    if (flight?.getCredentials !== getCredentials) {
      this.cancelAccountSelection();
      const controller = new AbortController();
      const startup = Promise.resolve().then(() =>
        this.runGuestStartup(getCredentials, controller.signal),
      );
      const result = waitFor(startup, controller.signal);
      flight = { getCredentials, controller, result, waiters: 0 };
      this.startupFlight = flight;
      const cleanup = () => {
        if (this.startupFlight?.result === result)
          this.startupFlight = undefined;
      };
      void result.then(cleanup, cleanup);
    }

    flight.waiters += 1;
    const release = () => {
      signal?.removeEventListener("abort", release);
      flight.waiters -= 1;
      if (this.startupFlight === flight && flight.waiters === 0)
        this.cancelStartup();
    };
    signal?.addEventListener("abort", release, { once: true });
    try {
      return await waitFor(flight.result, signal);
    } finally {
      if (!signal?.aborted) release();
    }
  }

  async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    const version = encodeURIComponent(this.config.clientVersion);
    const generation = this.unauthenticatedRequests.signal;
    const response = await this.request<unknown>(
      "GET",
      this.config.scope + "/bootstrap?client_version=" + version,
      undefined,
      false,
      signal,
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    const policy = parseBootstrap(response);
    if (gameScope(policy.project_id, policy.environment) !== this.config.scope) {
      throw new Error("invalid_response");
    }
    return policy;
  }

  async createGuest(signal?: AbortSignal): Promise<GuestCredentials> {
    const generation = this.unauthenticatedRequests.signal;
    const data = await this.request<unknown>(
      "POST",
      this.config.scope + "/guests",
      "{}",
      false,
      signal,
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    return parseGuest(data);
  }

  login(credentials: GuestCredentials, signal?: AbortSignal): Promise<Session> {
    return this.authenticate("/sessions", credentials, parseSession, signal);
  }

  signupCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomSession> {
    return this.authenticate(
      "/accounts/custom",
      credentials,
      parseCustomSession,
      signal,
    );
  }

  loginCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomSession> {
    return this.authenticate(
      "/sessions/custom",
      credentials,
      parseCustomSession,
      signal,
    );
  }

  async linkGuestToCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomLinkResult> {
    const generation = this.lifecycle.signal;
    const data = await this.request<unknown>(
      "POST",
      "/game/account/custom",
      JSON.stringify(credentials),
      true,
      signal,
      "preserve-on-401",
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    return parseCustomLink(data);
  }

  setSession(session?: string | Session): void {
    if (this.closed) throw new Error("client_closed");
    this.cancelAccountSelection();
    this.invalidateUnauthenticatedRequests();
    this.replaceActiveSession(session);
  }

  async refreshSession(signal?: AbortSignal): Promise<Session> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("client_closed");
    if (!this.refreshFlight) {
      this.requireSession();
      const generation = this.lifecycle.signal;
      const result = this.request<unknown>(
        "POST",
        "/game/session/refresh",
        "{}",
        true,
        undefined,
        "refresh",
      ).then((data) => {
        generation.throwIfAborted();
        const session = parseSession(data);
        // 같은 계정의 토큰을 교체하는 동안 진행 중인 쓰기 요청은 계속 처리한다.
        this.token = session.token;
        this.expiresAt = session.expires_at;
        return session;
      });
      this.refreshFlight = result;
      const cleanup = () => {
        if (this.refreshFlight === result) this.refreshFlight = undefined;
      };
      void result.then(cleanup, cleanup);
    }
    // 호출자가 취소하면 이 호출의 대기만 끝낸다. 공유 토큰 갱신은 계속한다.
    return waitFor(this.refreshFlight, signal);
  }

  async logout(signal?: AbortSignal): Promise<void> {
    const generation = this.lifecycle;
    if (!this.closed) {
      this.cancelAccountSelection();
      this.invalidateUnauthenticatedRequests();
    }
    try {
      await this.request<void>(
        "DELETE",
        "/game/session",
        undefined,
        true,
        signal,
      );
    } finally {
      // 로그아웃은 요청을 보낸 세션만 지운다.
      if (this.lifecycle === generation && !this.closed)
        this.replaceActiveSession();
    }
  }

  close(): void {
    this.closed = true;
    this.cancelAccountSelection();
    this.unauthenticatedRequests.abort();
    this.startedGuest = undefined;
    this.token = undefined;
    this.expiresAt = undefined;
    this.refreshFlight = undefined;
    this.lifecycle.abort();
    this.clearPendingSaves();
  }

  private replaceActiveSession(session?: string | Session): void {
    this.startedGuest = undefined;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.token = typeof session === "string" ? session : session?.token;
    this.expiresAt =
      typeof session === "string" ? undefined : session?.expires_at;
    this.refreshFlight = undefined;
    this.clearPendingSaves();
  }

  private invalidateUnauthenticatedRequests(): void {
    const requests = this.unauthenticatedRequests;
    this.unauthenticatedRequests = new AbortController();
    requests.abort();
  }

  private cancelStartup(): void {
    const flight = this.startupFlight;
    this.startupFlight = undefined;
    flight?.controller.abort();
  }

  private async runGuestStartup(
    getCredentials: GetGuestCredentials,
    signal: AbortSignal,
  ): Promise<StartupResult> {
    try {
      const policy = await this.bootstrap(signal);
      const blocked = blockedStartup(policy);
      if (blocked) return blocked;

      let session;
      try {
        signal.throwIfAborted();
        const credentials = await getCredentials(signal);
        signal.throwIfAborted();
        session = parseSession(
          await this.requestAccountSession("/sessions", credentials, signal),
        );
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof BackendError &&
          (error.code === "maintenance" || error.code === "update_required")
        ) {
          const latest = await this.bootstrap(signal);
          return (
            blockedStartup(latest) ?? { status: "temporary_failure", error }
          );
        }
        throw error;
      }

      signal.throwIfAborted();
      // 현재 초기화는 완료했고 다른 계정의 진행 중 요청은 세션 교체에서 취소한다.
      this.startupFlight = undefined;
      this.setSession(session);
      this.startedGuest = { getCredentials, policy: { ...policy } };
      return { status: "ready", session, policy };
    } catch (error) {
      signal.throwIfAborted();
      if (temporaryStartupFailure(error)) {
        return { status: "temporary_failure", error };
      }
      throw error;
    }
  }

  private requestAccountSession(
    path: AccountSessionPath,
    credentials: GuestCredentials | CustomCredentials,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      this.config.scope + path,
      JSON.stringify(credentials),
      false,
      signal,
    );
  }

  private cancelAccountSelection(): void {
    this.cancelStartup();
    const attempt = this.accountAttempt;
    this.accountAttempt = undefined;
    attempt?.abort();
  }

  private async authenticate<T extends Session>(
    path: AccountSessionPath,
    credentials: GuestCredentials | CustomCredentials,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("client_closed");
    // 직접 게스트 로그인은 시작할 때 세션을 지운다. 커스텀 인증은 성공 뒤 교체한다.
    if (path === "/sessions") this.setSession();
    else this.cancelAccountSelection();
    const attempt = new AbortController();
    this.accountAttempt = attempt;
    const caller = signal
      ? AbortSignal.any([attempt.signal, signal])
      : attempt.signal;
    try {
      const data = await this.requestAccountSession(path, credentials, caller);
      caller.throwIfAborted();
      const session = parse(data);
      this.accountAttempt = undefined;
      this.setSession(session);
      return session;
    } finally {
      if (this.accountAttempt === attempt) this.accountAttempt = undefined;
    }
  }

  private requireSession(): void {
    if (!this.token) throw new Error("session_required");
    if (this.expiresAt !== undefined && this.expiresAt <= Date.now() / 1000) {
      this.replaceActiveSession();
      throw new BackendError(401, "session_expired");
    }
  }

  private request<T>(
    method: string,
    path: string,
    body: string | undefined,
    authenticated: boolean,
    caller?: AbortSignal,
    sessionMode: SessionMode = "current",
  ): Promise<T> {
    try {
      if (this.closed) throw new Error("client_closed");
      caller?.throwIfAborted();
      const generation = (
        authenticated ? this.lifecycle : this.unauthenticatedRequests
      ).signal;
      const request = { method, path, body, generation, caller };
      if (!authenticated) return this.transport<T>(request);

      const prepareSession = sessionMode !== "refresh";
      // 만료 전에 시작한 토큰 갱신이 있으면 새 토큰을 기다린 뒤 만료 여부를 확인한다.
      if (!prepareSession || !this.refreshFlight) this.requireSession();
      if (
        prepareSession &&
        (this.refreshFlight ||
          (this.expiresAt !== undefined &&
            this.expiresAt - Date.now() / 1000 <=
              this.config.refreshBeforeSeconds))
      ) {
        return this.refreshSession(caller).then(() => {
          generation.throwIfAborted();
          caller?.throwIfAborted();
          this.requireSession();
          return this.sendAuthenticated<T>(request, sessionMode);
        });
      }
      return this.sendAuthenticated<T>(request, sessionMode);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private sendAuthenticated<T>(
    request: HttpRequest,
    sessionMode: SessionMode,
  ): Promise<T> {
    const token = this.token;
    return this.transport<T>({
      ...request,
      token,
      onUnauthorized: () => {
        // 계정 연결, 이전 토큰의 응답, 다른 요청의 토큰 갱신은 현재 세션을 지우지 않는다.
        if (
          sessionMode !== "preserve-on-401" &&
          this.token === token &&
          (sessionMode === "refresh" || !this.refreshFlight)
        ) {
          this.replaceActiveSession();
        }
      },
    });
  }
}
