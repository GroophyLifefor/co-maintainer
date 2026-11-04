/** Every step of the fake e2e gate must run with CM_FAKE_AI=1, the unit and
 * integration step included, so no test can reach a real AI provider when
 * the gate runs outside CI. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("every e2e:fake step sets CM_FAKE_AI to 1", () => {
  const source = readFileSync(join(import.meta.dirname, "e2e_fake.ts"), "utf8");
  // Each step runs from its `name:` to the next one (or the end of the list).
  const list = source.slice(
    source.indexOf("const steps"),
    source.indexOf("let failed"),
  );
  const parts = list.split(/name: "/).slice(1);
  if (parts.length < 4) throw new Error(`found ${parts.length} steps`);
  for (const part of parts) {
    const name = part.slice(0, part.indexOf('"'));
    if (!/CM_FAKE_AI: "1"/.test(part)) {
      throw new Error(`step "${name}" runs without CM_FAKE_AI=1`);
    }
  }
});
