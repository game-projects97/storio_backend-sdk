import type {
  PublishedChart,
  PublishedChartsPage,
  PublishedContentOptions,
  PublishedNoticesPage,
} from "./types.ts";
import { publishedContentPath } from "../../http/paths.ts";
import {
  parseCharts,
  parseNotices,
  parsePublishedChart,
} from "../../http/responses.ts";
import type { AuthenticatedRequest } from "../auth/index.ts";

export class Content {
  constructor(
    private readonly request: AuthenticatedRequest,
    private readonly getSessionSignal: () => AbortSignal,
  ) {}

  readPublishedCharts(
    options: PublishedContentOptions = {},
  ): Promise<PublishedChartsPage> {
    return this.readPublishedContent("chart", options, parseCharts);
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

  readPublishedNotices(
    options: PublishedContentOptions = {},
  ): Promise<PublishedNoticesPage> {
    return this.readPublishedContent("notice", options, parseNotices);
  }

  private async readPublishedContent<T>(
    kind: "chart" | "notice",
    options: PublishedContentOptions,
    parse: (value: unknown) => T,
    key?: string,
  ): Promise<T> {
    const { signal } = options;
    const path = publishedContentPath(kind, options, key);
    const generation = this.getSessionSignal();
    const data = await this.request<unknown>("GET", path, undefined, signal);
    generation.throwIfAborted();
    signal?.throwIfAborted();
    return parse(data);
  }
}
