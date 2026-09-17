import { closeAppDb, openAppDb } from "./app_db.ts";
import {
  deleteRemoteReviewInput,
  findRemoteReviewInputByRequest,
  insertRemoteReviewInput,
} from "./remote_review_inputs.ts";
import {
  findRemoteTokenByHash,
  insertRemoteToken,
  listRemoteTokens,
  setRemoteTokenActive,
  touchRemoteToken,
} from "./remote_tokens.ts";
import {
  createRemoteToken,
  hashRemoteBearerToken,
  resolveRemoteToken,
} from "../services/remote_tokens.ts";

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

Deno.test("remote tokens: create, resolve, deactivate", async () => {
  await withTempDb(async () => {
    const created = await createRemoteToken("ayse");
    if (!created.token.startsWith("cmr_")) {
      throw new Error("expected cmr_ prefix");
    }
    const hash = await hashRemoteBearerToken(created.token);
    const row = findRemoteTokenByHash(hash);
    if (!row || row.name !== "ayse") throw new Error("store row missing");
    const resolved = await resolveRemoteToken(created.token);
    if (!resolved || resolved.id !== created.id) {
      throw new Error("resolve failed");
    }
    setRemoteTokenActive(created.id, false);
    if (await resolveRemoteToken(created.token)) {
      throw new Error("inactive token should not resolve");
    }
  });
});

Deno.test("remote tokens: unique name", async () => {
  await withTempDb(async () => {
    await createRemoteToken("dup");
    let err = "";
    try {
      await createRemoteToken("dup");
    } catch (error) {
      err = String(error);
    }
    if (!err.includes("name_taken")) {
      throw new Error(`expected name_taken, got ${err}`);
    }
  });
});

Deno.test("remote review inputs: idempotency key", async () => {
  await withTempDb(async () => {
    insertRemoteToken("t1", "test", "abc");
    insertRemoteReviewInput({
      jobId: "job1",
      revisionJson: "{}",
      capabilitiesJson: "{}",
      requestId: "req-1",
      tokenId: "t1",
    });
    const found = findRemoteReviewInputByRequest("t1", "req-1");
    if (!found || found.job_id !== "job1") throw new Error("lookup failed");
    deleteRemoteReviewInput("job1");
    if (findRemoteReviewInputByRequest("t1", "req-1")) {
      throw new Error("expected deleted");
    }
    if (listRemoteTokens().length !== 1) throw new Error("token row");
  });
});

Deno.test("touchRemoteToken throttles to once per minute", async () => {
  await withTempDb(async () => {
    insertRemoteToken("t1", "n", "hash");
    touchRemoteToken("t1");
    const first = listRemoteTokens()[0].last_used_at;
    touchRemoteToken("t1");
    const second = listRemoteTokens()[0].last_used_at;
    if (!first || first !== second) {
      throw new Error("second touch within minute should not update");
    }
  });
});
