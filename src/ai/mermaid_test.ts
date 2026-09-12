import { MERMAID_TOOL, MERMAID_TYPES, readMermaidSyntaxes } from "./mermaid.ts";

Deno.test("Mermaid syntax tool documents every supported type", () => {
  for (const name of MERMAID_TYPES) {
    const docs = readMermaidSyntaxes({ tools: [name] }, 1);
    if (!docs.includes(`# ${name}`) || !docs.includes("Configuration:")) {
      throw new Error(`incomplete Mermaid docs for ${name}`);
    }
  }
});

Deno.test("Mermaid syntax tool enforces the requested tool limit", () => {
  let failed = false;
  try {
    readMermaidSyntaxes(
      { tools: ["treeView-beta", "architecture-beta"] },
      1,
    );
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("initial review accepted more than one diagram");
});

Deno.test("Mermaid tool schema exposes a bounded tools array", () => {
  const parameters = MERMAID_TOOL.function.parameters as Record<
    string,
    unknown
  >;
  const properties = parameters.properties as Record<string, unknown>;
  const tools = properties.tools as Record<string, unknown>;
  if (
    tools.maxItems !== 5 ||
    (tools.items as Record<string, unknown>)?.type !== "string"
  ) {
    throw new Error(`unexpected schema ${JSON.stringify(MERMAID_TOOL)}`);
  }
});
