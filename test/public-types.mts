import {
  Backend,
  BackendError,
  type Bootstrap,
  type CustomCredentials,
  type CustomLinkResult,
  type CustomSession,
  type GuestCredentials,
  type Progress,
  type PublishedChart,
  type PublishedChartsPage,
  type PublishedContentOptions,
  type PublishedNotice,
  type PublishedNoticesPage,
  type SavedProgress,
  type SaveProgress,
  type Session,
  type StartupResult,
} from "backend-sdk";

export async function checkPublicTypes(backend: Backend): Promise<void> {
  const bootstrap: Bootstrap = await backend.bootstrap();
  const guest: GuestCredentials = await backend.createGuest();
  const startup: StartupResult = await backend.startGuestSession(
    async () => guest,
  );
  const session: Session = await backend.login(guest);
  const current: SavedProgress = await backend.readProgress();
  const progress: Progress = current.progress;
  const save: SaveProgress = {
    expected_version: current.version,
    request_id: "test-request",
    progress,
  };
  const saved: SavedProgress = await backend.saveProgress(save);
  const charts: PublishedChartsPage = await backend.readPublishedCharts();
  const chart: PublishedChart | undefined =
    await backend.readPublishedChart("settings");
  const contentOptions: PublishedContentOptions = {
    locale: "ko-KR",
    fallbackLocale: "en",
  };
  const notices: PublishedNoticesPage =
    await backend.readPublishedNotices(contentOptions);
  const notice: PublishedNotice | undefined = notices.items.find(() => true);
  const custom: CustomCredentials = {
    custom_id: "custom",
    password: "test-password",
  };
  const customSession: CustomSession = await backend.signupCustom(custom);
  const linked: CustomLinkResult = await backend.linkGuestToCustom(custom);
  const relogin: CustomSession = await backend.loginCustom(custom);
  const error: Error = new BackendError(401, "session_expired");
  void [
    bootstrap,
    startup,
    session,
    saved,
    charts,
    chart,
    notice,
    customSession,
    linked,
    relogin,
    error,
  ];
}
