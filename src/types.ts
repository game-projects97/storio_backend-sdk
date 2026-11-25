export type Environment = "development" | "production";

export type Bootstrap = {
  project_id: string;
  environment: Environment;
  policy_revision: number;
  maintenance_active: boolean;
  maintenance_message: string;
  version_status: "required" | "recommended" | "supported";
  minimum_version: string;
  recommended_version: string;
  update_url: string;
};

export type GuestCredentials = { player_id: string; credential: string };

export type Session = { token: string; expires_at: number };

export type CustomCredentials = { custom_id: string; password: string };

export type CustomSession = Session & {
  player_id: string;
  kind: "custom";
  token_type: "Bearer";
};

export type CustomLinkResult = {
  player_id: string;
  kind: "custom";
  custom_id: string;
};

export type StartupResult =
  | { status: "ready"; session: Session; policy: Bootstrap }
  | { status: "maintenance"; policy: Bootstrap }
  | { status: "update_required"; policy: Bootstrap }
  | { status: "temporary_failure"; error: unknown };

export type Progress = {
  schema_version: 1;
  stage: number;
  intro_seen: boolean;
};

export type SavedProgress = { version: number; progress: Progress };

export type SaveProgress = {
  expected_version: number;
  request_id: string;
  progress: Progress;
};

type ChartCell = string | number | boolean;

export type PublishedChart = {
  id: string;
  kind: "chart";
  key: string;
  locale: string;
  revision: number;
  publication_version: number;
  body: {
    columns: { name: string; type: "string" | "number" | "boolean" }[];
    rows: Record<string, ChartCell>[];
  };
};

export type PublishedChartsPage = {
  items: PublishedChart[];
  next_cursor: string | null;
};

export type PublishedNotice = {
  id: string;
  kind: "notice";
  key: string;
  locale: string;
  revision: number;
  publication_version: number;
  body: { title: string; body: string };
};

export type PublishedNoticesPage = {
  items: PublishedNotice[];
  next_cursor: string | null;
};

export type PublishedContentOptions = {
  locale?: string;
  fallbackLocale?: string;
  cursor?: string;
  signal?: AbortSignal;
};
