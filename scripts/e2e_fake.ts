/** Fake-AI end-to-end gate.
 *
 * Runs the unit/integration suite, the local review e2e (fake AI + fake gh)
 * and the dashboard browser smoke. No real provider, no real GitHub, no
 * network cost. This is the gate every implementation step must pass before
 * the live e2e at the end.
 */
import { commandOutput, envToObject } from "../src/util/runtime.ts";

const steps: { name: string; args: string[]; env?: Record<string, string> }[] =
  [
    {
      name: "unit and integration",
      args: [
        "--test",
        "src/**/*.test.ts",
        "scripts/**/*.test.ts",
        "benchmark/**/*.test.ts",
      ],
      // Same as CI: no test may reach a real AI provider.
      env: { CM_FAKE_AI: "1" },
    },
    {
      name: "local review e2e",
      args: ["scripts/review_local_e2e.ts"],
      env: { CM_FAKE_AI: "1" },
    },
    {
      name: "dashboard smoke",
      args: ["scripts/dashboard_smoke.ts"],
      env: { CM_FAKE_AI: "1" },
    },
    {
      name: "palette smoke",
      args: ["scripts/palette_smoke.ts"],
      env: { CM_FAKE_AI: "1" },
    },
    {
      name: "job refresh smoke",
      args: ["scripts/job_refresh_smoke.ts"],
      env: { CM_FAKE_AI: "1" },
    },
    {
      name: "commit watch smoke",
      args: ["scripts/commit_watch_smoke.ts"],
      env: { CM_FAKE_AI: "1" },
    },
  ];

let failed = false;

for (const step of steps) {
  const started = Date.now();
  const result = await commandOutput(process.execPath, {
    args: step.args,
    env: { ...envToObject(), ...step.env },
    stdout: "piped",
    stderr: "piped",
  });
  const ms = Date.now() - started;
  const out = new TextDecoder().decode(result.stdout).trim();
  const err = new TextDecoder().decode(result.stderr).trim();
  if (!result.success) {
    failed = true;
    console.error(`FAIL ${step.name} (${ms}ms, exit ${result.code})`);
    if (out) console.error(out);
    if (err) console.error(err);
    break;
  }
  console.log(`ok ${step.name} (${ms}ms)`);
}

if (failed) process.exit(1);
console.log("e2e:fake ok");
