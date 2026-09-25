import { test } from "node:test";
import { webhookReachabilityProblem } from "./webhook_reachability.ts";

test("localhost and loopback are flagged as unreachable", () => {
  for (const url of [
    "http://localhost:5000/github/webhook",
    "http://localhost/github/webhook",
    "https://foo.localhost/hook",
    "http://127.0.0.1:8080/hook",
    "http://127.9.9.9/hook",
    "http://0.0.0.0:5000/hook",
    "http://[::1]/hook",
  ]) {
    if (!webhookReachabilityProblem(url)) {
      throw new Error(`${url} should be unreachable`);
    }
  }
});

test("private network ranges are flagged", () => {
  for (const url of [
    "http://10.0.0.5/hook",
    "http://172.16.0.1/hook",
    "http://172.31.255.255/hook",
    "http://192.168.1.10/hook",
    "http://169.254.169.254/hook",
    "http://[fd00::1]/hook",
    "http://[fe80::1]/hook",
  ]) {
    const problem = webhookReachabilityProblem(url);
    if (!problem || !problem.toLowerCase().includes("private")) {
      throw new Error(`${url} should read as private, got ${problem}`);
    }
  }
});

test("public hosts stay quiet", () => {
  for (const url of [
    "https://example.com/github/webhook",
    "https://co-maintainer.example.dev/hook",
    "https://203.0.113.7/hook",
    "http://172.32.0.1/hook",
    "http://172.15.0.1/hook",
    "http://192.169.0.1/hook",
    // A single-label internal host is indistinguishable from a public host
    // here and `serve` accepts it, so this must not warn.
    "http://serve:5000/github/webhook",
    "https://[2606:4700::1111]/hook",
  ]) {
    const problem = webhookReachabilityProblem(url);
    if (problem) throw new Error(`${url} should be reachable, got ${problem}`);
  }
});
