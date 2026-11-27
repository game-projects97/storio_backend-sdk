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
