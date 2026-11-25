import {
  PlatformClient,
  PlatformError,
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
} from "@storio/platform-sdk";

export async function checkPublicTypes(client: PlatformClient): Promise<void> {
  const bootstrap: Bootstrap = await client.bootstrap();
  const guest: GuestCredentials = await client.createGuest();
  const startup: StartupResult = await client.startGuestSession(
    async () => guest,
  );
  const session: Session = await client.login(guest);
  const current: SavedProgress = await client.readProgress();
  const progress: Progress = current.progress;
  const save: SaveProgress = {
    expected_version: current.version,
    request_id: "test-request",
    progress,
  };
  const saved: SavedProgress = await client.saveProgress(save);
  const charts: PublishedChartsPage = await client.readPublishedCharts();
  const chart: PublishedChart | undefined =
    await client.readPublishedChart("settings");
  const contentOptions: PublishedContentOptions = {
    locale: "ko-KR",
    fallbackLocale: "en",
  };
  const notices: PublishedNoticesPage =
    await client.readPublishedNotices(contentOptions);
  const notice: PublishedNotice | undefined = notices.items.find(() => true);
  const custom: CustomCredentials = {
    custom_id: "custom",
    password: "test-password",
  };
  const customSession: CustomSession = await client.signupCustom(custom);
  const linked: CustomLinkResult = await client.linkGuestToCustom(custom);
  const relogin: CustomSession = await client.loginCustom(custom);
  const error: Error = new PlatformError(401, "session_expired");
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
