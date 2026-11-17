/** The GitHub review's Metadata names how many tool calls the review made and
 * the MCP servers it ran, by name only (issue 79). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyToolUsage } from "../ai/tool_gate.ts";
import { toolsMetadataLine } from "./review.ts";

test("the Tools line counts calls and names MCP servers only", () => {
  const usage = { ...emptyToolUsage(), calls: 11 };
  assert.equal(
    toolsMetadataLine(usage, ["tracker"]),
    "- Tools: 11 calls · MCP: tracker\n",
  );
  assert.equal(toolsMetadataLine({ ...usage, calls: 1 }), "- Tools: 1 call\n");
  assert.equal(
    toolsMetadataLine(emptyToolUsage(), ["tracker", "wiki"]),
    "- Tools: 0 calls · MCP: tracker, wiki\n",
  );
});

test("no tool call and no MCP server adds no line", () => {
  assert.equal(toolsMetadataLine(emptyToolUsage(), []), "");
  assert.equal(toolsMetadataLine(undefined), "");
});
