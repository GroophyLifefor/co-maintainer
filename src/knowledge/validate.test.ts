import { validateSkill } from "./validate.ts";
import { testSource } from "../testing/helpers.ts";
import { test } from "node:test";

test("skill validation rejects raw dumps and unsupported references", async () => {
  const markdown = `---
name: fixture
description: fixture
---

# fixture

## Tests

- Run \`pnpm test\`.
- Use the labels \`x:size/tiny\`, \`x:size/small\`, and \`x:type/ci\`.
- Inspect \`missing/file.ts\`.

| raw | table |
| --- | --- |
| value | value |
`;
  const result = await validateSkill(markdown, testSource());
  if (result.valid) throw new Error("invalid skill passed validation");
  if (!result.errors.some((error) => error.includes("raw Markdown table"))) {
    throw new Error("raw table was not rejected");
  }
  if (!result.errors.some((error) => error.includes("absent from source"))) {
    throw new Error("unsupported path was not rejected");
  }
});

test("commands and linked files do not fail skill validation", async () => {
  const markdown = `---
name: fixture
description: fixture
---

# fixture

## Tests

- Run \`cargo build:bundle\` and \`cargo lint\`.
- Read [pull requests](./doc/contributing/pull-requests.md) and [PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md).
`;
  const result = await validateSkill(markdown, testSource());
  if (!result.valid) {
    throw new Error(result.errors.join("; "));
  }
});

test("reference problems can be downgraded to warnings", async () => {
  const markdown = `---
name: fixture
description: fixture
---

# fixture

## Tests

- Inspect \`missing/file.ts\`.
`;
  const result = await validateSkill(markdown, testSource(), "warning");
  if (!result.valid) throw new Error(result.errors.join("; "));
  if (!result.warnings.some((item) => item.includes("missing/file.ts"))) {
    throw new Error("the stale path was not reported as a warning");
  }
});
