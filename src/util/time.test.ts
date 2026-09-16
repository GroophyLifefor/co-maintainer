import { nowIso, relativeTime } from "./time.ts";

Deno.test("relativeTime uses short labels without a dash or semicolon", () => {
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const cases: [string, string][] = [
    ["2026-09-11T11:59:50.000Z", "just now"],
    ["2026-09-11T11:00:00.000Z", "1 hour ago"],
    ["2026-09-10T12:00:00.000Z", "yesterday"],
    ["2026-09-01T12:00:00.000Z", "10 days ago"],
  ];
  for (const [iso, expected] of cases) {
    const got = relativeTime(iso, now);
    if (got !== expected) throw new Error(`${iso} -> ${got}`);
    if (got.includes("\u2014") || got.includes(";")) {
      throw new Error(got);
    }
  }
});

Deno.test("nowIso is always a UTC ISO8601 timestamp", () => {
  const value = nowIso();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`not a UTC ISO8601 timestamp: ${value}`);
  }
});
