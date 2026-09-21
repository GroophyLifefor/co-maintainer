import { test } from "node:test";
import { readConfig } from "../config.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { configPasswordStore, memoryPasswordStore } from "./auth.ts";

async function withTempConfig(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  try {
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
  }
}

test("the config store rejects everything until a password is set", async () => {
  await withTempConfig(async () => {
    const store = configPasswordStore();
    if (await store.verify("")) throw new Error("empty password verified");
    if (await store.verify("anything"))
      throw new Error("verified with no hash");
  });
});

test("the config store keeps a hash, never the password", async () => {
  await withTempConfig(async () => {
    const store = configPasswordStore();
    await store.set("correct-horse");
    if (!(await store.verify("correct-horse"))) {
      throw new Error("the right password was rejected");
    }
    if (await store.verify("wrong-horse")) {
      throw new Error("a wrong password was accepted");
    }
    const hash = readConfig().dashboardPasswordHash;
    if (!hash || hash.includes("correct-horse")) {
      throw new Error(`unexpected stored value: ${hash}`);
    }
  });
});

test("the memory store never accepts a blank password", async () => {
  const store = memoryPasswordStore("");
  if (await store.verify("")) throw new Error("blank password verified");
});
