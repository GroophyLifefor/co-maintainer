/** What the Activity URL asks for. Every filter lives in the query, so a
 * filtered list is a link any count on the dashboard can open, and the
 * pager and the chips keep the rest of the filter. */
import { ACTIVITY_KINDS } from "./activity_words.ts";
import {
  ACTIVITY_STATES,
  type ActivityState,
  type ActivityStoreFilter,
} from "../../store/activity.ts";

export const ACTIVITY_PER_PAGE = 20;

export type ActivityQuery = {
  status?: ActivityState;
  kind?: string;
  repo?: string;
  pr?: number;
  /** A day, `YYYY-MM-DD`, read in UTC. */
  from?: string;
  to?: string;
  q?: string;
  /** The failed list also shows dismissed and resolved failures. */
  settled?: boolean;
  /** The skipped list also shows the bot's own comments. */
  own?: boolean;
  page: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string | null): string | undefined {
  if (!value || !DAY.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? undefined : value;
}

/** Each value checked. Anything that does not fit is dropped, so a
 * hand-edited link still shows a list. */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const status = params.get("status") ?? "";
  const kind = params.get("kind") ?? "";
  const pr = Number(params.get("pr") ?? "");
  const page = Number(params.get("page") ?? 1);
  const trimmed = (name: string) => params.get(name)?.trim() || undefined;
  return {
    status: (ACTIVITY_STATES as string[]).includes(status)
      ? (status as ActivityState)
      : undefined,
    kind: ACTIVITY_KINDS.some((entry) => entry.id === kind) ? kind : undefined,
    repo: trimmed("repo"),
    pr: Number.isSafeInteger(pr) && pr > 0 ? pr : undefined,
    from: day(params.get("from")),
    to: day(params.get("to")),
    q: trimmed("q")?.slice(0, 200),
    settled: params.get("settled") === "1" || undefined,
    own: params.get("own") === "1" || undefined,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function nextDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

/** The store filter for a query. */
export function activityStoreFilter(query: ActivityQuery): ActivityStoreFilter {
  return {
    state: query.status,
    types: ACTIVITY_KINDS.find((entry) => entry.id === query.kind)?.types,
    repo: query.repo,
    pr: query.pr,
    sinceIso: query.from ? `${query.from}T00:00:00.000Z` : undefined,
    untilIso: query.to ? nextDay(query.to) : undefined,
    q: query.q,
    withSettled: query.settled,
  };
}

/** True when anything narrows the Recent list. */
export function isFiltered(query: ActivityQuery): boolean {
  return Boolean(
    query.status ||
    query.kind ||
    query.repo ||
    query.pr ||
    query.from ||
    query.to ||
    query.q,
  );
}

/** The same query with some values changed, as a link. The page goes back
 * to 1 unless it is the value being changed. */
export function activityHref(
  query: ActivityQuery,
  patch: Partial<Record<keyof ActivityQuery, string | number | undefined>> = {},
): string {
  const values: Record<string, string | number | undefined> = {
    status: query.status,
    kind: query.kind,
    repo: query.repo,
    pr: query.pr,
    from: query.from,
    to: query.to,
    q: query.q,
    settled: query.settled ? 1 : undefined,
    own: query.own ? 1 : undefined,
    page: undefined,
    ...patch,
  };
  if (values.page === 1) values.page = undefined;
  // Showing settled failures only means something on the failed list.
  if (values.status !== "failed") values.settled = undefined;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(name, String(value));
  }
  const encoded = params.toString();
  return encoded ? `/activity?${encoded}` : "/activity";
}
