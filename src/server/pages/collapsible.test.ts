/** The CLI equivalent is secondary detail. It starts closed in a native
 * disclosure, so a keyboard user can open it and a screen reader announces it. */
import { test } from "node:test";
import { renderAddRepo } from "./add_repo.ts";

type Disclosure = { open: boolean; summary: string; body: string };

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function disclosureFor(html: string, marker: string): Disclosure | undefined {
  const pattern = /<details\b([^>]*)>([\s\S]*?)<\/details>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const body = match[2]!;
    if (!body.includes(marker)) continue;
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(body);
    return {
      open: /(^|\s)open(\s|=|$)/i.test(match[1]!),
      summary: summary ? decode(summary[1]!) : "",
      body,
    };
  }
  return undefined;
}

test("the add repository CLI equivalent starts closed inside an accessible disclosure", async () => {
  const response = renderAddRepo("alice", {
    repos: [
      { fullName: "acme/widgets", account: "acme", alreadyActive: false },
    ],
  });
  const html = await response.text();
  const disclosure = disclosureFor(html, "co-maintainer init");
  if (!disclosure) {
    throw new Error("the CLI equivalent is not inside a <details> disclosure");
  }
  if (disclosure.open) {
    throw new Error("the CLI equivalent disclosure is open on first load");
  }
  if (!/cli equivalent/i.test(disclosure.summary)) {
    throw new Error(
      `the CLI equivalent summary has no accessible name: ${JSON.stringify(disclosure.summary)}`,
    );
  }
  if (!disclosure.body.includes("co-maintainer init")) {
    throw new Error("the CLI equivalent has no command");
  }
});
