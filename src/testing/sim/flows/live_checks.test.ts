/** What a live run would report, without a model. Each flow runs once with the
 * fake AI. Its checks are then judged twice over the same run: as they are,
 * and with the sim saying a real model answered (`../live_probe.ts`). A live
 * run cannot be tried without a key, so this is the cheapest honest proof that
 * the skips are where they should be and nothing else moves:
 *
 * - the same checks, in the same order, with the same names;
 * - a skipped one says why, and a live run never fails it;
 * - every check that is not skipped gives the same result either way, so
 *   what a flow keeps running live is exactly what holds for any answer. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckResult } from "../flow.ts";
import { FLOWS } from "./index.ts";

const PROBE = join(import.meta.dirname, "..", "live_probe.ts");

type Probe = {
  passed: boolean;
  failed: string[];
  fake: CheckResult[];
  live: CheckResult[];
};

/** The probe of one flow, in its own process. All of them start at once. */
function probe(name: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PROBE, name],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CM_FAKE_AI: "1" },
      },
      (error, stdout, stderr) => {
        const line = stdout
          .split("\n")
          .find((row) => row.startsWith("LIVE_PROBE "));
        if (error || !line) {
          reject(new Error(`${name}: ${error?.message ?? ""}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(line.slice("LIVE_PROBE ".length)) as Probe);
      },
    );
  });
}

/** Flows whose commands need a POSIX spawn. Their own tests skip Windows too
 * (`extensions.test.ts`), so no probe is started for them there. */
const POSIX_ONLY = new Set(["extensions"]);
const posixOnly = (name: string) =>
  process.platform === "win32" && POSIX_ONLY.has(name);

const probes = new Map(
  FLOWS.filter((flow) => flow.checks).map((flow) => [
    flow.name,
    posixOnly(flow.name) ? undefined : probe(flow.name),
  ]),
);

/** How many checks of each flow a live run skips because of the model, and
 * only those: a check a flow also skips with the fake AI is not counted. A
 * flow that is not listed has none. Change it with the flow, on purpose. */
const SKIPPED_LIVE: Record<string, number> = {
  app: 8,
  "cli-pr": 21,
  "cli-pr-carry": 27,
  "diagram-runtime": 5,
  extensions: 2,
  "init-sync": 10,
  instructions: 7,
  "intent-file": 6,
  "large-diff": 6,
  local: 17,
  remote: 12,
  "review-checks": 2,
};

for (const [name, pending] of probes) {
  test(`live checks of ${name}: the same checks, skipped with a reason or unchanged`, async (t) => {
    if (!pending) return t.skip("needs a POSIX spawn");
    const { passed, failed, fake, live } = await pending;
    assert.equal(passed, true, failed.join("\n"));
    assert.deepEqual(
      live.map((item) => item.name),
      fake.map((item) => item.name),
    );
    let skipped = 0;
    for (const [index, item] of live.entries()) {
      const before = fake[index]!;
      if (item.skipped !== undefined) {
        assert.equal(item.ok, true, item.name);
        // A check the flow skips with the fake AI too (a known product bug)
        // is skipped the same way live.
        if (before.skipped === undefined) {
          assert.match(item.skipped, /^live AI: .{10,}/, item.name);
          skipped++;
        }
        continue;
      }
      assert.equal(item.ok, before.ok, item.name);
      assert.equal(item.detail, before.detail, item.name);
    }
    assert.equal(skipped, SKIPPED_LIVE[name] ?? 0, `${name}: skipped live`);
  });
}
