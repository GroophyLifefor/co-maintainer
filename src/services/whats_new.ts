/** "Check for new versions" in the dashboard sidebar. Only an admin's click
 * runs it, after the dashboard said it asks github.com: it reads the latest
 * stable release and CHANGELOG.md of the co-maintainer repository, and
 * returns the changelog sections newer than the running version. Nothing
 * about this server is sent, and nothing runs on its own. */
import { VERSION } from "../version.ts";
import { fetchLatestRelease, isNewer, parseStable } from "./update_check.ts";

/** Where the changelog is read from. */
export const CHANGELOG_URL =
  "https://raw.githubusercontent.com/GroophyLifefor/co-maintainer/main/CHANGELOG.md";

/** The repository page the sidebar's Star button opens. */
export const REPOSITORY_URL = "https://github.com/GroophyLifefor/co-maintainer";

/** Most sections returned, so a server many releases behind gets a readable
 * dialog and a link for the rest. */
const MAX_SECTIONS = 10;

/** Most characters of one section, as a guard against an odd changelog. */
const MAX_SECTION_CHARS = 20_000;

export type ChangelogSection = {
  version: string;
  date: string | undefined;
  /** The section's Markdown, without its `## [x.y.z]` heading. */
  body: string;
  /** One short line per change, for the dialog: each bullet's bold lead,
   * or its first sentence when it has none. */
  items: string[];
};

export type WhatsNew = {
  running: string;
  latest: string | undefined;
  newer: boolean;
  /** Sections newer than the running version, newest first. When there is
   * no newer release, the running version's own section, so the dialog can
   * still say what this version brought. */
  sections: ChangelogSection[];
  /** True when more newer sections exist than were returned. */
  more: boolean;
  changelogUrl: string;
};

/** One short line per bullet of a section: `- **Lead.** More text` gives
 * `Lead.`, a bullet without a bold lead gives its first sentence. Markdown
 * other than inline code is dropped. */
export function shortItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split("\n")) {
    const bullet = /^\s*[-*] (.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]!.trim();
    const lead = /^\*\*(.+?)\*\*/.exec(text);
    const short = lead
      ? lead[1]!
      : (/^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text);
    items.push(short.replace(/\*\*/g, "").trim());
  }
  return items;
}

/** Every released `## [x.y.z] - date` section of a changelog, in file order
 * (newest first in this repository). `Unreleased` is skipped. */
export function changelogSections(changelog: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  const lines: string[] = [];
  const close = () => {
    if (!current) return;
    current.body = lines.join("\n").trim().slice(0, MAX_SECTION_CHARS);
    current.items = shortItems(current.body);
    out.push(current);
    lines.length = 0;
  };
  for (const line of changelog.split("\n")) {
    const heading = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (heading) {
      close();
      current = parseStable(heading[1]!)
        ? { version: heading[1]!, date: heading[2], body: "", items: [] }
        : undefined;
      continue;
    }
    if (current) lines.push(line);
  }
  close();
  return out;
}

/** The sections a server running `running` has not seen, up to `latest`. */
export function newerSections(
  sections: ChangelogSection[],
  running: string,
  latest: string | undefined,
): ChangelogSection[] {
  return sections.filter(
    (section) =>
      isNewer(section.version, running) &&
      (latest === undefined || !isNewer(section.version, latest)),
  );
}

async function fetchChangelog(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(CHANGELOG_URL, {
    headers: { "user-agent": `co-maintainer/${VERSION}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return await response.text();
}

/** Reads the latest release and the changelog and says what is new. */
export async function checkWhatsNew(
  opts: { fetcher?: typeof fetch; running?: string } = {},
): Promise<WhatsNew> {
  const fetcher = opts.fetcher ?? fetch;
  const running = opts.running ?? VERSION;
  const [release, changelog] = await Promise.all([
    fetchLatestRelease(fetcher),
    fetchChangelog(fetcher),
  ]);
  const all = changelogSections(changelog);
  const newer =
    release.latest !== undefined && isNewer(release.latest, running);
  const unseen = newerSections(all, running, release.latest);
  const shown = newer
    ? unseen.slice(0, MAX_SECTIONS)
    : all
        .filter((section) => section.version === running.split("-")[0])
        .slice(0, 1);
  return {
    running,
    latest: release.latest,
    newer,
    sections: shown,
    more: newer && unseen.length > MAX_SECTIONS,
    changelogUrl: `${REPOSITORY_URL}/blob/main/CHANGELOG.md`,
  };
}
