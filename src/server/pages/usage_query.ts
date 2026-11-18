/** What the Usage URL asks for: a range and, optionally, one repository and
 * one pull request author. The page, its Export button and the JSON API read
 * the same query, so the download is always the data on screen. */
import type { UsageScope } from "../../store/reviews.ts";

export type UsageQuery = UsageScope & { range: "7d" | "30d" | "90d" };

export function parseUsageQuery(params: URLSearchParams): UsageQuery {
  const range = params.get("range") ?? "";
  const trimmed = (name: string) =>
    params.get(name)?.trim().slice(0, 200) || undefined;
  return {
    range: range === "7d" || range === "90d" ? range : "30d",
    repo: trimmed("repo"),
    author: trimmed("author"),
  };
}

/** The same query with some values changed, as a link under `base`. */
export function usageHref(
  query: UsageQuery,
  patch: Partial<Record<keyof UsageQuery, string | undefined>> = {},
  base = "/usage",
): string {
  const values: Record<string, string | undefined> = {
    range: query.range,
    repo: query.repo,
    author: query.author,
    ...patch,
  };
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(name, value);
  }
  return `${base}?${params.toString()}`;
}
