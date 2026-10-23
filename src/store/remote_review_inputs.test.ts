/** The remote review input row keeps a client's one-run review instructions
 * so a retry reuses them. */
import { closeAppDb, openAppDb } from "./app_db.ts";
import {
  getRemoteReviewInput,
  insertRemoteReviewInput,
} from "./remote_review_inputs.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

test("the one-run system prompts survive a round trip", async () => {
  await withTempDb(() => {
    insertRemoteReviewInput({
      jobId: "job-1",
      revisionJson: "{}",
      capabilitiesJson: "{}",
      requestId: "req-1",
      tokenId: "tok-1",
      billedTo: "server",
      systemPromptAdd: "Extra.",
      systemPromptOverride: "Strict.",
    });
    const row = getRemoteReviewInput("job-1");
    if (
      row?.system_prompt_add !== "Extra." ||
      row?.system_prompt_override !== "Strict."
    ) {
      throw new Error(JSON.stringify(row));
    }
  });
});

test("omitting the prompts stores null", async () => {
  await withTempDb(() => {
    insertRemoteReviewInput({
      jobId: "job-2",
      revisionJson: "{}",
      capabilitiesJson: "{}",
      requestId: "req-2",
      tokenId: "tok-1",
      billedTo: "server",
    });
    const row = getRemoteReviewInput("job-2");
    if (
      row?.system_prompt_add !== null ||
      row?.system_prompt_override !== null
    ) {
      throw new Error(JSON.stringify(row));
    }
  });
});
