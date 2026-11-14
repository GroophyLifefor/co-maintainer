/** The schema table on the extensions docs page comes from the code. The
 * versioning rules are prose this test cannot check, which is why they live
 * on that page next to the table. */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFile } from "../testing/runtime.ts";
import {
  applySchemaBlock,
  responseSchemaTable,
  SCHEMA_BLOCK_END,
  SCHEMA_BLOCK_START,
} from "./schema.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("the schema table in docs/md/extensions.md matches the code", async () => {
  const md = await readTextFile(join(root, "docs", "md", "extensions.md"));
  const block = `${SCHEMA_BLOCK_START}\n${responseSchemaTable()}\n${SCHEMA_BLOCK_END}`;
  if (!md.includes(block) || applySchemaBlock(md) !== md) {
    throw new Error(
      "docs/md/extensions.md has a stale schema table. Run npm run docs:build.",
    );
  }
});
