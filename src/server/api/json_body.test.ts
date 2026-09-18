import { readJsonObject } from "./json_body.ts";
import { test } from "node:test";

test("readJsonObject rejects null JSON body", async () => {
  const request = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
  const result = await readJsonObject(request);
  if (!(result instanceof Response) || result.status !== 400) {
    throw new Error(`expected 400, got ${result}`);
  }
});
