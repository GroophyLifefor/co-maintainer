/** A fake remote review server for the action's CI test (CORE-131).
 *
 *   node scripts/fake_remote_server.ts --findings=blocking|none \
 *     --info=<file> --log=<file>
 *
 * It answers like a real server would for one review, writes its address and
 * the certificate to trust into `--info` once it is listening, and keeps every
 * request it saw in `--log`. The workflow reads the
 * log to prove what the action actually sent. */
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startFakeRemote, writeCaCert } from "../src/testing/fake_remote.ts";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

const findings = option("findings");
const info = option("info");
const log = option("log");
if ((findings !== "blocking" && findings !== "none") || !info || !log) {
  console.error(
    "usage: fake_remote_server.ts --findings=blocking|none --info=<file> --log=<file>",
  );
  process.exit(2);
}

const BLOCKING = {
  id: "f1",
  state: "new",
  closeReason: null,
  severity: "P1",
  blocking: true,
  path: "action-test-marker.txt",
  lineFrom: 1,
  lineTo: 1,
  title: "[P1 · blocking] `action-test-marker.txt`: `marker`",
  body: "A blocking finding from the fake server.",
  suggestion: null,
};

const remote = await startFakeRemote({
  sync: [
    {
      schemaVersion: 1,
      status: "done",
      logs: [],
      result: {
        findings: findings === "blocking" ? [BLOCKING] : [],
        summary: {},
        usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.0001 },
      },
      abort: null,
    },
  ],
});

const ca = await writeCaCert(dirname(info));
writeFileSync(info, JSON.stringify({ url: remote.url, ca }));

// The log is rewritten as requests arrive, so it is complete without relying on
// a signal, which a Windows machine does not deliver the way Linux does.
setInterval(
  () => writeFileSync(log, JSON.stringify(remote.requests)),
  250,
).unref();

process.on("SIGTERM", () => {
  writeFileSync(log, JSON.stringify(remote.requests));
  void remote.close().then(() => process.exit(0));
});
