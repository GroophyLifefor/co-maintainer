import { FakeAiProvider } from "./fake.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

test("FakeAiProvider reads CM_FAKE_REVIEW_FILE", async () => {
  const path = `${tempDirSync()}/custom.md`;
  await writeTextFile(path, "## Findings\n\nCustom body.\n");
  const prev = getEnv("CM_FAKE_REVIEW_FILE");
  setEnv("CM_FAKE_REVIEW_FILE", path);
  try {
    const response = await new FakeAiProvider().complete({
      prompt: "test",
      maxTokens: 1,
      job: "test",
    });
    if (!response.text.includes("Custom body")) {
      throw new Error(response.text);
    }
  } finally {
    if (prev === undefined) deleteEnv("CM_FAKE_REVIEW_FILE");
    else setEnv("CM_FAKE_REVIEW_FILE", prev);
  }
});
