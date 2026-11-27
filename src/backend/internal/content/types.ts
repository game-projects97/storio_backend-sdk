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
