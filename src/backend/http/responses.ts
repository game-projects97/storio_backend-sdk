import type {
  Bootstrap,
  CustomLinkResult,
  CustomSession,
  GuestCredentials,
  Session,
} from "../internal/auth/types.ts";
import type {
  PublishedChart,
  PublishedChartsPage,
  PublishedNoticesPage,
} from "../internal/content/types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCursor(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function parseBootstrap(value: unknown): Bootstrap {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.project_id) ||
    (value.environment !== "development" &&
      value.environment !== "production") ||
    !isCounter(value.policy_revision) ||
    typeof value.maintenance_active !== "boolean" ||
    typeof value.maintenance_message !== "string" ||
    (value.version_status !== "supported" &&
      value.version_status !== "recommended" &&
      value.version_status !== "required") ||
    !isNonEmptyString(value.minimum_version) ||
    !isNonEmptyString(value.recommended_version) ||
    typeof value.update_url !== "string"
  ) {
    throw new Error("invalid_response");
  }
  return value as Bootstrap;
}

export function parseGuest(value: unknown): GuestCredentials {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.player_id) ||
    !isNonEmptyString(value.credential)
  ) {
    throw new Error("invalid_response");
  }
  return value as GuestCredentials;
}

export function parseSession(value: unknown): Session {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.token) ||
    typeof value.expires_at !== "number" ||
    !Number.isFinite(value.expires_at) ||
    value.expires_at <= 0
  ) {
    throw new Error("invalid_response");
  }
  return value as Session;
}

export function parseCustomSession(value: unknown): CustomSession {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.player_id) ||
    value.kind !== "custom" ||
    value.token_type !== "Bearer" ||
    !isCounter(value.expires_at)
  ) {
    throw new Error("invalid_response");
  }
  return parseSession(value) as CustomSession;
}

export function parseCustomLink(value: unknown): CustomLinkResult {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.player_id) ||
    value.kind !== "custom" ||
    !isNonEmptyString(value.custom_id)
  ) {
    throw new Error("invalid_response");
  }
  return value as CustomLinkResult;
}

function isNoticeBody(value: unknown): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.body)
  );
}

function isChartBody(value: unknown): boolean {
  if (
    !isObject(value) ||
    !Array.isArray(value.columns) ||
    !value.columns.length ||
    !Array.isArray(value.rows)
  ) {
    return false;
  }

  const columnTypes = new Map<string, "string" | "number" | "boolean">();
  for (const column of value.columns) {
    if (
      !isObject(column) ||
      !isNonEmptyString(column.name) ||
      columnTypes.has(column.name) ||
      (column.type !== "string" &&
        column.type !== "number" &&
        column.type !== "boolean")
    ) {
      return false;
    }
    columnTypes.set(column.name, column.type);
  }

  return value.rows.every((row: unknown) => {
    if (!isObject(row)) return false;
    const cells = Object.entries(row);
    return (
      cells.length === columnTypes.size &&
      cells.every(
        ([name, cell]) =>
          typeof cell === columnTypes.get(name) &&
          (typeof cell !== "number" || Number.isFinite(cell)),
      )
    );
  });
}

function parsePublishedPage(
  value: unknown,
  kind: "chart" | "notice",
  validBody: (body: unknown) => boolean,
): Record<string, unknown> {
  if (
    !isObject(value) ||
    !Array.isArray(value.items) ||
    (value.next_cursor !== null && !isCursor(value.next_cursor)) ||
    !value.items.every(
      (item: unknown) =>
        isObject(item) &&
        item.kind === kind &&
        isNonEmptyString(item.id) &&
        isNonEmptyString(item.key) &&
        isNonEmptyString(item.locale) &&
        isCounter(item.revision) &&
        isCounter(item.publication_version) &&
        validBody(item.body),
    )
  ) {
    throw new Error("invalid_response");
  }
  return value;
}

export function parseCharts(value: unknown): PublishedChartsPage {
  return parsePublishedPage(value, "chart", isChartBody) as PublishedChartsPage;
}

export function parseNotices(value: unknown): PublishedNoticesPage {
  return parsePublishedPage(
    value,
    "notice",
    isNoticeBody,
  ) as PublishedNoticesPage;
}

export function parsePublishedChart(
  value: unknown,
  key: string,
): PublishedChart | undefined {
  const page = parseCharts(value);
  const chart = page.items[0];
  if (
    page.next_cursor !== null ||
    page.items.length > 1 ||
    (chart && chart.key !== key)
  ) {
    throw new Error("invalid_response");
  }
  return chart;
}
