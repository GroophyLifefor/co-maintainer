import { validateSkill } from "./validate.ts";
import { testSource } from "../testing/helpers.ts";

Deno.test("skill validation rejects raw dumps and unsupported references", async () => {
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
  const result = await validateSkill(markdown, ".", testSource());
  if (result.valid) throw new Error("invalid skill passed validation");
  if (!result.errors.some((error) => error.includes("raw Markdown table"))) {
    throw new Error("raw table was not rejected");
  }
  if (!result.errors.some((error) => error.includes("absent from source"))) {
    throw new Error("unsupported path was not rejected");
  }
});

Deno.test("skill validation accepts commands defined by deno tasks", async () => {
  const markdown = `---
name: fixture
description: fixture
---

# fixture

## Tests

- Run \`deno test --allow-all\` and \`deno check main.ts\`.
`;
  const result = await validateSkill(
    markdown,
    ".",
    testSource({
      tree: ["deno.json"],
      files: {
        "deno.json": JSON.stringify({
          tasks: {
            test: "deno test --allow-all",
            check: "deno check main.ts",
          },
        }),
      },
    }),
  );
  if (!result.valid) {
    throw new Error(`deno task commands were rejected: ${result.errors}`);
  }
});
