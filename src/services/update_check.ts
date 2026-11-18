/** A newer co-maintainer release, and the update the host runs.
 *
 * Nothing here calls out unless the host sets `CM_UPDATE_URL`. A server
 * without it never asks for the latest release, so the privacy page stays
 * true for a self-hosted install. With it, the latest stable release is read
 * from GitHub at most once a day, the answer is kept beside `app.db`, and a
 * page only ever reads that kept answer, so no page waits on the network.
 *
 * The Update button POSTs the target version to `CM_UPDATE_URL`. The host
 * restarts the instance on that image. The button never offers a version
 * older than or equal to the running one. */
import { dirname } from "node:path";
import { appDbPath } from "../store/app_db.ts";
import { VERSION } from "../version.ts";
import {
  getEnv,
  isNotFound,
  readTextFileSync,
  writeTextFileSync,
  mkdirSync,
} from "../util/runtime.ts";

export const RELEASES_URL =
  "https://api.github.com/repos/GroophyLifefor/co-maintainer/releases/latest";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The host's update endpoint, or undefined when it set none. */
export function updateUrl(): string | undefined {
  const value = getEnv("CM_UPDATE_URL")?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** `0.7.14` as numbers. A pre-release or anything else that is not a plain
 * `x.y.z` is not a stable version and reads as undefined. */
export function parseStable(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

/** True when `candidate` is a stable version newer than `running`. A
 * running pre-release compares by its `x.y.z` part. */
export function isNewer(candidate: string, running: string): boolean {
  const next = parseStable(candidate);
  const now = parseStable(running.split("-")[0] ?? running);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i]! !== now[i]!) return next[i]! > now[i]!;
  }
  return false;
}

export type ReleaseCheck = {
  /** When GitHub was last asked, an ISO time. */
  checkedAt: string;
  /** The latest stable version, `0.7.15`, when the answer had one. */
  latest?: string;
  /** Its release notes page. */
  notesUrl?: string;
};

export type UpdateState = {
  target: string;
  from: string;
  startedAt: string;
  status: "requested" | "failed";
  message?: string;
};

type Kept = { check?: ReleaseCheck; update?: UpdateState };

function keptPath(): string {
  return `${dirname(appDbPath())}/update-check.json`;
}

function readKept(): Kept {
  try {
    const value = JSON.parse(readTextFileSync(keptPath()));
    return value && typeof value === "object" ? (value as Kept) : {};
  } catch (error) {
    if (!isNotFound(error)) {
      console.error("[update] Could not read the kept release check.");
    }
    return {};
  }
}

function writeKept(next: Kept): void {
  try {
    mkdirSync(dirname(keptPath()), { recursive: true });
    writeTextFileSync(keptPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.error(
      "[update] Could not keep the release check:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Reads the latest stable release from GitHub. */
export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
): Promise<{ latest?: string; notesUrl?: string }> {
  const response = await fetcher(RELEASES_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `co-maintainer/${VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = (await response.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    prerelease?: unknown;
    draft?: unknown;
  };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  if (body.prerelease === true || body.draft === true || !parseStable(tag)) {
    return {};
  }
  return {
    latest: tag.replace(/^v/, ""),
    notesUrl: typeof body.html_url === "string" ? body.html_url : undefined,
  };
}

let checking: Promise<void> | undefined;

/** Asks GitHub when the host set `CM_UPDATE_URL` and the kept answer is a
 * day old or missing. Returns at once when there is nothing to do, and never
 * runs two checks at the same time. A failed check is kept too, so a server
 * that cannot reach GitHub asks again a day later, not on every page. */
export function refreshReleaseCheck(
  opts: { nowMs?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  if (!updateUrl()) return Promise.resolve();
  const nowMs = opts.nowMs ?? Date.now();
  const kept = readKept();
  const last = kept.check ? Date.parse(kept.check.checkedAt) : Number.NaN;
  if (Number.isFinite(last) && nowMs - last < DAY_MS) return Promise.resolve();
  if (checking) return checking;
  checking = (async () => {
    const checkedAt = new Date(nowMs).toISOString();
    try {
      const found = await fetchLatestRelease(opts.fetcher);
      writeKept({ ...readKept(), check: { checkedAt, ...found } });
    } catch (error) {
      console.error(
        "[update] Could not check for a newer version:",
        error instanceof Error ? error.message : String(error),
      );
      writeKept({ ...readKept(), check: { ...kept.check, checkedAt } });
    } finally {
      checking = undefined;
    }
  })();
  return checking;
}

export type UpdateNotice = {
  running: string;
  /** Set only when a newer stable release is known. */
  latest?: string;
  notesUrl?: string;
  /** The host can update this instance. */
  canUpdate: boolean;
  /** An update this dashboard asked for that has not landed yet. */
  update?: UpdateState;
  checkedAt?: string;
};

/** What the sidebar and Settings show, from the kept answer only. Starts a
 * check in the background when one is due. */
export function updateNotice(): UpdateNotice {
  const canUpdate = Boolean(updateUrl());
  if (!canUpdate) return { running: VERSION, canUpdate };
  void refreshReleaseCheck();
  const kept = readKept();
  const latest =
    kept.check?.latest && isNewer(kept.check.latest, VERSION)
      ? kept.check.latest
      : undefined;
  // An update that landed, or one for a version this instance already runs,
  // is over.
  const update =
    kept.update && isNewer(kept.update.target, VERSION)
      ? kept.update
      : undefined;
  return {
    running: VERSION,
    latest,
    notesUrl: latest ? kept.check?.notesUrl : undefined,
    canUpdate,
    update,
    checkedAt: kept.check?.checkedAt,
  };
}

/** POSTs the target version to the host. Only the latest known stable
 * release newer than the running one is accepted. */
export async function startUpdate(
  target: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; state: UpdateState } | { ok: false; problem: string }> {
  const url = updateUrl();
  if (!url) return { ok: false, problem: "This server has no CM_UPDATE_URL." };
  const known = readKept().check?.latest;
  if (!isNewer(target, VERSION)) {
    return {
      ok: false,
      problem: `${target} is not newer than ${VERSION}. An older version is never offered.`,
    };
  }
  if (target !== known) {
    return { ok: false, problem: `${target} is not the latest release.` };
  }
  const startedAt = new Date().toISOString();
  let state: UpdateState;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `co-maintainer/${VERSION}`,
      },
      body: JSON.stringify({ version: target, current: VERSION }),
      signal: AbortSignal.timeout(15_000),
    });
    state = response.ok
      ? { target, from: VERSION, startedAt, status: "requested" }
      : {
          target,
          from: VERSION,
          startedAt,
          status: "failed",
          message: `The update endpoint answered ${response.status}.`,
        };
  } catch (error) {
    state = {
      target,
      from: VERSION,
      startedAt,
      status: "failed",
      message: `The update endpoint could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  writeKept({ ...readKept(), update: state });
  return { ok: true, state };
}
