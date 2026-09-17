import { FakeAiProvider } from "./fake.ts";

Deno.test("FakeAiProvider reads CM_FAKE_REVIEW_FILE", async () => {
  const path = `${Deno.makeTempDirSync()}/custom.md`;
  await Deno.writeTextFile(path, "## Findings\n\nCustom body.\n");
  const prev = Deno.env.get("CM_FAKE_REVIEW_FILE");
  Deno.env.set("CM_FAKE_REVIEW_FILE", path);
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
    if (prev === undefined) Deno.env.delete("CM_FAKE_REVIEW_FILE");
    else Deno.env.set("CM_FAKE_REVIEW_FILE", prev);
  }
});
