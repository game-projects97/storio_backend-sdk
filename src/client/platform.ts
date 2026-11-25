import { PlatformError } from "../api/error.ts";
import { gameScope, publishedContentPath } from "../api/paths.ts";
import {
  parseBootstrap,
  parseCharts,
  parseCustomLink,
  parseCustomSession,
  parseGuest,
  parseNotices,
  parsePublishedChart,
  parseSession,
} from "../api/responses.ts";
import type {
  Bootstrap,
  GuestCredentials,
  Session,
  CustomCredentials,
  CustomSession,
  CustomLinkResult,
  StartupResult,
  SavedProgress,
  SaveProgress,
  PublishedChart,
  PublishedChartsPage,
  PublishedNoticesPage,
  PublishedContentOptions,
} from "../types.ts";
import { resolveClientConfig, type ClientOptions } from "./config.ts";
import { waitFor } from "./wait-for.ts";

type GetGuestCredentials = (signal?: AbortSignal) => Promise<GuestCredentials>;
type AccountSessionPath = "/sessions" | "/accounts/custom" | "/sessions/custom";
type StartupFlight = {
  getCredentials: GetGuestCredentials;
  controller: AbortController;
  result: Promise<StartupResult>;
  waiters: number;
};

const networkFailures = new WeakSet<TypeError>();

function blockedStartup(policy: Bootstrap): StartupResult | undefined {
  if (policy.maintenance_active) return { status: "maintenance", policy };
  if (policy.version_status === "required") {
    return { status: "update_required", policy };
  }
}

function temporaryStartupFailure(error: unknown): boolean {
  if (error instanceof PlatformError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    (error instanceof TypeError && networkFailures.has(error)) ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/** Storio 게임 클라이언트. 로컬 저장과 계정 이전은 게임에서 처리한다. */
export class PlatformClient {
  private readonly baseUrl: string;
  private readonly scope: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;
  private lifecycle = new AbortController();
  private unauthenticatedRequests = new AbortController();
  private token: string | undefined;
  private expiresAt: number | undefined;
  private refreshFlight: Promise<Session> | undefined;
  private accountAttempt: AbortController | undefined;
  private startupFlight: StartupFlight | undefined;
  private startedGuest:
    { getCredentials: GetGuestCredentials; policy: Bootstrap } | undefined;
  private readonly refreshBeforeSeconds: number;
  private closed = false;
  private readonly saves = new Map<
    string,
    {
      input: string;
      result: Promise<SavedProgress>;
    }
  >();

  constructor(options: ClientOptions) {
    const config = resolveClientConfig(options);
    this.refreshBeforeSeconds = config.refreshBeforeSeconds;
    this.baseUrl = config.baseUrl;
    this.scope = config.scope;
    this.clientVersion = config.clientVersion;
    this.timeoutMs = config.timeoutMs;
  }

  /** 로컬 저장과 계정 전환 준비를 마친 뒤 호출한다. */
  setSession(session?: string | Session): void {
    if (this.closed) throw new Error("client_closed");
    this.cancelAccountSelection();
    this.invalidateUnauthenticatedRequests();
    this.replaceActiveSession(session);
  }

  private replaceActiveSession(session?: string | Session): void {
    this.startedGuest = undefined;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.token = typeof session === "string" ? session : session?.token;
    this.expiresAt =
      typeof session === "string" ? undefined : session?.expires_at;
    this.refreshFlight = undefined;
    this.saves.clear();
  }

  private invalidateUnauthenticatedRequests(): void {
    const requests = this.unauthenticatedRequests;
    this.unauthenticatedRequests = new AbortController();
    requests.abort();
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
    this.saves.clear();
  }

  async bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    const version = encodeURIComponent(this.clientVersion);
    const generation = this.unauthenticatedRequests.signal;
    const response = await this.request<unknown>(
      "GET",
      this.scope + "/bootstrap?client_version=" + version,
      undefined,
      false,
      signal,
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    const policy = parseBootstrap(response);
    if (gameScope(policy.project_id, policy.environment) !== this.scope) {
      throw new Error("invalid_response");
    }
    return policy;
  }

  async createGuest(signal?: AbortSignal): Promise<GuestCredentials> {
    const generation = this.unauthenticatedRequests.signal;
    const data = await this.request<unknown>(
      "POST",
      this.scope + "/guests",
      "{}",
      false,
      signal,
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    return parseGuest(data);
  }

  /** 같은 자격 증명 콜백의 초기화 요청은 세션이 유효한 동안 결과를 공유한다. */
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
          error instanceof PlatformError &&
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

  login(credentials: GuestCredentials, signal?: AbortSignal): Promise<Session> {
    return this.authenticate("/sessions", credentials, parseSession, signal);
  }

  private requestAccountSession(
    path: AccountSessionPath,
    credentials: GuestCredentials | CustomCredentials,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      this.scope + path,
      JSON.stringify(credentials),
      false,
      signal,
    );
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

  readProgress(signal?: AbortSignal): Promise<SavedProgress> {
    return this.request("GET", "/game/progress", undefined, true, signal);
  }

  /** 현재 게임 세션에 게시된 차트를 한 페이지씩 읽는다. */
  readPublishedCharts(
    options: PublishedContentOptions = {},
  ): Promise<PublishedChartsPage> {
    return this.readPublishedContent("chart", options, parseCharts);
  }

  readPublishedNotices(
    options: PublishedContentOptions = {},
  ): Promise<PublishedNoticesPage> {
    return this.readPublishedContent("notice", options, parseNotices);
  }

  readPublishedChart(
    key: string,
    options: Omit<PublishedContentOptions, "cursor"> = {},
  ): Promise<PublishedChart | undefined> {
    return this.readPublishedContent(
      "chart",
      options,
      (value) => parsePublishedChart(value, key),
      key,
    );
  }

  private async readPublishedContent<T>(
    kind: "chart" | "notice",
    options: PublishedContentOptions,
    parse: (value: unknown) => T,
    key?: string,
  ): Promise<T> {
    const { signal } = options;
    const path = publishedContentPath(kind, options, key);
    const generation = this.lifecycle.signal;
    const data = await this.request<unknown>(
      "GET",
      path,
      undefined,
      true,
      signal,
    );
    generation.throwIfAborted();
    signal?.throwIfAborted();
    return parse(data);
  }

  saveProgress(
    input: SaveProgress,
    signal?: AbortSignal,
  ): Promise<SavedProgress> {
    const requestId = input.request_id;
    const serialized = JSON.stringify(input);
    const existing = this.saves.get(requestId);
    if (existing) {
      if (existing.input !== serialized) {
        return Promise.reject(new Error("request_id_reused"));
      }
      // 첫 호출자가 요청을 소유한다. 이후 호출자는 각자의 대기만 취소할 수 있다.
      return waitFor(existing.result, signal);
    }
    const result = this.request<SavedProgress>(
      "PUT",
      "/game/progress",
      serialized,
      true,
      signal,
    );
    const entry = { input: serialized, result };
    this.saves.set(requestId, entry);
    const cleanup = () => {
      if (this.saves.get(requestId) === entry) this.saves.delete(requestId);
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  /** 유효한 액세스 토큰을 교체한다. 세션이 만료되거나 폐기되면 다시 로그인해야 한다. */
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

  private requireSession(): void {
    if (!this.token) throw new Error("session_required");
    if (this.expiresAt !== undefined && this.expiresAt <= Date.now() / 1000) {
      this.replaceActiveSession();
      throw new PlatformError(401, "session_expired");
    }
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

  private async request<T>(
    method: string,
    path: string,
    body: string | undefined,
    authenticated: boolean,
    caller?: AbortSignal,
    sessionMode: "current" | "refresh" | "preserve-on-401" = "current",
  ): Promise<T> {
    if (this.closed) throw new Error("client_closed");
    caller?.throwIfAborted();
    const generation = (
      authenticated ? this.lifecycle : this.unauthenticatedRequests
    ).signal;
    const prepareSession = sessionMode !== "refresh";
    if (authenticated) {
      // 만료 전에 시작한 토큰 갱신이 있으면 새 토큰을 기다린 뒤 만료 여부를 확인한다.
      if (!prepareSession || !this.refreshFlight) this.requireSession();
      if (
        prepareSession &&
        (this.refreshFlight ||
          (this.expiresAt !== undefined &&
            this.expiresAt - Date.now() / 1000 <= this.refreshBeforeSeconds))
      ) {
        await this.refreshSession(caller);
        generation.throwIfAborted();
        caller?.throwIfAborted();
        this.requireSession();
      }
    }
    const requestToken = this.token;
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
      this.timeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      const response = await fetch(this.baseUrl + path, {
        method,
        credentials: "omit",
        mode: this.baseUrl.startsWith("http") ? undefined : "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Client-Version": this.clientVersion,
          ...(authenticated ? { Authorization: `Bearer ${requestToken}` } : {}),
        },
        body,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        controller.signal.throwIfAborted();
        // 401 뒤에는 요청을 재시도하거나 토큰을 갱신하지 않는다.
        // 이전 토큰의 응답이 늦게 도착하면 새 토큰은 유지한다.
        if (
          authenticated &&
          // 계정 전환 요청의 401은 커스텀 비밀번호 불일치도 뜻한다.
          sessionMode !== "preserve-on-401" &&
          response.status === 401 &&
          this.token === requestToken &&
          // 갱신 중에 다른 요청이 401을 받아도 갱신은 계속한다.
          // 갱신 요청 자체가 401을 받으면 세션을 지운다.
          (!prepareSession || !this.refreshFlight)
        ) {
          this.replaceActiveSession();
        }
        throw new PlatformError(
          response.status,
          problem?.code ?? "request_failed",
        );
      }
      const data = response.status === 204 ? undefined : await response.json();
      // 전송 계층이 취소 뒤 응답을 반환한 경우에도 요청을 실패로 처리한다.
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
  }
}
