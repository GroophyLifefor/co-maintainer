import { test } from "node:test";
import {
  hashPassword,
  passwordProblem,
  verifyPasswordHash,
} from "./password.ts";

test("a hash verifies the right password and rejects a wrong one", async () => {
  const hash = await hashPassword("correct-horse");
  if (!(await verifyPasswordHash("correct-horse", hash))) {
    throw new Error("the right password was rejected");
  }
  if (await verifyPasswordHash("wrong-horse", hash)) {
    throw new Error("a wrong password was accepted");
  }
});

test("hashing the same password twice gives different hashes", async () => {
  const [first, second] = await Promise.all([
    hashPassword("correct-horse"),
    hashPassword("correct-horse"),
  ]);
  if (first === second) throw new Error("the salt was reused");
  if (first.includes("correct-horse")) throw new Error("plain text leaked");
});

test("a malformed stored hash never verifies", async () => {
  for (const stored of ["", "plain", "scrypt$$", "md5$aa$bb", "scrypt$zz$"]) {
    if (await verifyPasswordHash("anything", stored)) {
      throw new Error(`accepted malformed hash: ${stored}`);
    }
  }
});

test("passwordProblem enforces the length bounds", () => {
  if (!passwordProblem("short")) throw new Error("short password passed");
  if (!passwordProblem("x".repeat(201)))
    throw new Error("long password passed");
  if (passwordProblem("long enough")) throw new Error("valid password failed");
});
