import type {
  Bootstrap,
  CustomCredentials,
  CustomLinkResult,
  CustomSession,
  GuestCredentials,
  PublishedChart,
  PublishedChartsPage,
  PublishedContentOptions,
  PublishedNoticesPage,
  SavedProgress,
  SaveProgress,
  Session,
  StartupResult,
} from "../types.ts";
import { resolveBackendConfig, type BackendOptions } from "./config.ts";
import { createRequest } from "./http/request.ts";
import { Auth, type GetGuestCredentials } from "./internal/auth.ts";
import { Content } from "./internal/content.ts";
import { Progress } from "./internal/progress.ts";

/** Storio 게임 백엔드 SDK. 로컬 저장과 계정 이전은 게임에서 처리한다. */
export class Backend {
  private readonly auth: Auth;
  private readonly progress: Progress;
  private readonly content: Content;

  constructor(options: BackendOptions) {
    const config = resolveBackendConfig(options);
    this.auth = new Auth(config, createRequest(config), () => {
      this.progress.clear();
    });
    this.progress = new Progress(this.auth.requestAuthenticated);
    this.content = new Content(
      this.auth.requestAuthenticated,
      () => this.auth.sessionSignal,
    );
  }

  /** 같은 자격 증명 콜백의 초기화 요청은 세션이 유효한 동안 결과를 공유한다. */
  startGuestSession(
    getCredentials: GetGuestCredentials,
    signal?: AbortSignal,
  ): Promise<StartupResult> {
    return this.auth.startGuestSession(getCredentials, signal);
  }

  bootstrap(signal?: AbortSignal): Promise<Bootstrap> {
    return this.auth.bootstrap(signal);
  }

  createGuest(signal?: AbortSignal): Promise<GuestCredentials> {
    return this.auth.createGuest(signal);
  }

  login(credentials: GuestCredentials, signal?: AbortSignal): Promise<Session> {
    return this.auth.login(credentials, signal);
  }

  signupCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomSession> {
    return this.auth.signupCustom(credentials, signal);
  }

  loginCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomSession> {
    return this.auth.loginCustom(credentials, signal);
  }

  linkGuestToCustom(
    credentials: CustomCredentials,
    signal?: AbortSignal,
  ): Promise<CustomLinkResult> {
    return this.auth.linkGuestToCustom(credentials, signal);
  }

  /** 로컬 저장과 계정 전환 준비를 마친 뒤 호출한다. */
  setSession(session?: string | Session): void {
    this.auth.setSession(session);
  }

  /** 유효한 액세스 토큰을 교체한다. 세션이 만료되거나 폐기되면 다시 로그인해야 한다. */
  refreshSession(signal?: AbortSignal): Promise<Session> {
    return this.auth.refreshSession(signal);
  }

  logout(signal?: AbortSignal): Promise<void> {
    return this.auth.logout(signal);
  }

  readProgress(signal?: AbortSignal): Promise<SavedProgress> {
    return this.progress.readProgress(signal);
  }

  saveProgress(
    input: SaveProgress,
    signal?: AbortSignal,
  ): Promise<SavedProgress> {
    return this.progress.saveProgress(input, signal);
  }

  /** 현재 게임 세션에 게시된 차트를 한 페이지씩 읽는다. */
  readPublishedCharts(
    options: PublishedContentOptions = {},
  ): Promise<PublishedChartsPage> {
    return this.content.readPublishedCharts(options);
  }

  readPublishedChart(
    key: string,
    options: Omit<PublishedContentOptions, "cursor"> = {},
  ): Promise<PublishedChart | undefined> {
    return this.content.readPublishedChart(key, options);
  }

  readPublishedNotices(
    options: PublishedContentOptions = {},
  ): Promise<PublishedNoticesPage> {
    return this.content.readPublishedNotices(options);
  }

  close(): void {
    this.auth.close();
  }
}
