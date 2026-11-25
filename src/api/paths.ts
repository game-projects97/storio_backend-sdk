import type { Environment, PublishedContentOptions } from "../types.ts";

export function gameScope(projectId: string, environment: Environment): string {
  return `/game/${encodeURIComponent(projectId)}/${environment}`;
}

export function publishedContentPath(
  kind: "chart" | "notice",
  options: PublishedContentOptions,
  key?: string,
): string {
  const query = new URLSearchParams();
  if (options.locale !== undefined) query.set("locale", options.locale);
  if (options.fallbackLocale !== undefined) {
    query.set("fallback_locale", options.fallbackLocale);
  }
  if (key !== undefined) query.set("key", key);
  else if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const params = query.toString();
  return "/game/content/" + kind + (params ? "?" + params : "");
}
