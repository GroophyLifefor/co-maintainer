import {
  normalizeGithubRemote,
  parseNameStatusZ,
  parseNumstatZ,
  pathsMissingPatches,
} from "./git_parse.ts";
import { test } from "node:test";

const cases: [string, string | "unsupported"][] = [
  ["https://github.com/Owner/Repo.git", "Owner/Repo"],
  ["https://github.com/Owner/Repo", "Owner/Repo"],
  ["https://user@github.com/Owner/Repo.git", "Owner/Repo"],
  ["git@github.com:Owner/Repo.git", "Owner/Repo"],
  ["ssh://git@github.com/Owner/Repo.git", "Owner/Repo"],
  ["ssh://git@github.com:22/Owner/Repo", "Owner/Repo"],
  ["https://github.com/Owner/Repo/", "Owner/Repo"],
  ["https://gitlab.com/Owner/Repo", "unsupported"],
  ["https://github.example.com/Owner/Repo", "unsupported"],
  ["C:\\repos\\x", "unsupported"],
];

for (const [url, want] of cases) {
  test(`normalizeGithubRemote: ${url}`, () => {
    const result = normalizeGithubRemote(url);
    if (want === "unsupported") {
      if (result.ok) throw new Error("expected unsupported");
      return;
    }
    if (!result.ok || result.fullName !== want) {
      throw new Error(JSON.stringify(result));
    }
  });
}

test("parseNameStatusZ: added modified renamed", () => {
  const raw = "A\0src/new.ts\0M\0src/old.ts\0R100\0src/a.ts\0src/b.ts\0";
  const entries = parseNameStatusZ(raw);
  if (
    entries.length !== 3 ||
    entries[0].status !== "added" ||
    entries[2].previousPath !== "src/a.ts"
  ) {
    throw new Error(JSON.stringify(entries));
  }
});

test("pathsMissingPatches: flags absent or empty bulk patches", () => {
  const statuses = parseNameStatusZ("M\0src/a.ts\0D\0gone.ts\0");
  const patches = new Map([["src/a.ts", ""]]);
  const missing = pathsMissingPatches(statuses, patches);
  if (missing.length !== 1 || missing[0] !== "src/a.ts") {
    throw new Error(JSON.stringify(missing));
  }
});

test("parseNumstatZ: binary and counts", () => {
  const raw = "2\t1\tsrc/a.ts\x00-\t-\tassets/logo.png\x00";
  const map = parseNumstatZ(raw);
  const a = map.get("src/a.ts");
  const b = map.get("assets/logo.png");
  if (a?.additions !== 2 || b?.binary !== true) {
    throw new Error(JSON.stringify([a, b]));
  }
});
