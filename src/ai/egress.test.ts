import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fetch as undiciFetch } from "undici";
import {
  checkEgress,
  EgressRefused,
  guardedDispatcher,
  isBlockedAddress,
  setEgressGuard,
  setEgressResolverForTest,
} from "./egress.ts";
import { deleteEnv, getEnv, setEnv } from "../testing/runtime.ts";

test("private, loopback, link-local, metadata and mapped addresses are blocked", () => {
  for (const address of [
    "10.0.0.7",
    "127.0.0.1",
    "169.254.169.254",
    "172.20.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
    "nonsense",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "20.1.2.3", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("checkEgress refuses a name that resolves anywhere private, only while the guard is on", async () => {
  setEgressResolverForTest(async (host) =>
    host === "internal.test" ? ["20.1.2.3", "10.0.0.7"] : ["20.1.2.3"],
  );
  const allowPrivate = getEnv("CM_AI_ALLOW_PRIVATE");
  try {
    await checkEgress("https://internal.test/v1");
    setEgressGuard(true);
    await assert.rejects(
      checkEgress("https://internal.test/v1"),
      EgressRefused,
    );
    await assert.rejects(
      checkEgress("https://169.254.169.254/v1"),
      EgressRefused,
    );
    await assert.rejects(checkEgress("http://[::1]:8000/v1"), EgressRefused);
    await assert.rejects(
      checkEgress("http://[::ffff:169.254.169.254]/v1"),
      EgressRefused,
    );
    await checkEgress("https://public.test/v1");
    setEnv("CM_AI_ALLOW_PRIVATE", "1");
    await checkEgress("https://internal.test/v1");
  } finally {
    if (allowPrivate === undefined) deleteEnv("CM_AI_ALLOW_PRIVATE");
    else setEnv("CM_AI_ALLOW_PRIVATE", allowPrivate);
    setEgressGuard(false);
    setEgressResolverForTest();
  }
});

test("the guarded agent refuses to connect to a name that resolves to loopback", async () => {
  const server = createServer((_req, res) => res.end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    setEgressGuard(true);
    await assert.rejects(
      undiciFetch(`http://localhost:${port}/`, {
        dispatcher: guardedDispatcher(10_000),
      }),
    );
    setEgressGuard(false);
    const open = await undiciFetch(`http://localhost:${port}/`, {
      dispatcher: guardedDispatcher(10_000),
    });
    assert.equal(open.status, 200);
  } finally {
    setEgressGuard(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
