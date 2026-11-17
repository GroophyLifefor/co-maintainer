/** A tiny stdio MCP server for tests and `e2e:simulate`, written to disk as a
 * Node script and started with `node <path>`.
 *
 * It lists, over two `tools/list` pages:
 * - `get_issue`, read-only, answers `FAKE_MCP_ISSUE_TEXT` (or a fixed text)
 *   and one image part
 * - `close_issue`, marked `readOnlyHint: false`
 * - `no_hint`, with no annotations, answers `ok`
 * - `bad_schema`, whose input schema is not an object
 * - `slow`, never answers
 * - `crash`, exits with code 3
 * - `env`, answers the names in its environment
 * - `fail`, answers with `isError`
 *
 * `--hang-start` never answers `initialize`. `--exit-start` writes to
 * stderr and exits at once. It prints one line that is not JSON before it
 * answers, sends the client a `ping`, and exits when stdin closes. With
 * `FAKE_MCP_EXIT_FILE` set it writes that file as it exits. */
import { join } from "node:path";
import { writeTextFileSync } from "../util/runtime.ts";

/** What `get_issue` answers when `FAKE_MCP_ISSUE_TEXT` is not set. */
export const FAKE_MCP_ISSUE_TEXT =
  "The customer reported that the export button silently drops every row after the first thousand entries";

const SCRIPT = String.raw`
import fs from "node:fs"
const argv = process.argv.slice(2)
if (argv.includes("--exit-start")) {
  process.stderr.write("fake mcp server refused to start\n")
  process.exit(2)
}
const hang = argv.includes("--hang-start")
const issue = process.env.FAKE_MCP_ISSUE_TEXT || ${JSON.stringify(FAKE_MCP_ISSUE_TEXT)}
const object = { type: "object", properties: { id: { type: "string" } } }
const page1 = [
  { name: "get_issue", description: "Read one issue.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "close_issue", description: "Close one issue.", inputSchema: object, annotations: { readOnlyHint: false } },
  { name: "no_hint", inputSchema: { type: "object" } },
]
const page2 = [
  { name: "bad_schema", inputSchema: { type: "string" } },
  { name: "slow", inputSchema: { type: "object" } },
  { name: "crash", inputSchema: { type: "object" } },
  { name: "env", inputSchema: { type: "object" } },
  { name: "fail", inputSchema: { type: "object" } },
]
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const text = (value) => ({ content: [{ type: "text", text: value }] })
process.stdout.write("fake mcp server ready\n")
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at = buffer.indexOf("\n")
  while (at !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf("\n")
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on("end", () => process.exit(0))
if (process.env.FAKE_MCP_EXIT_FILE) {
  process.on("exit", () => fs.writeFileSync(process.env.FAKE_MCP_EXIT_FILE, "stopped"))
}
function handle(message) {
  if (message.method === undefined) return
  if (message.id === undefined) return
  const id = message.id
  if (message.method === "initialize") {
    if (hang) return
    send({ id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } })
    send({ id: "server-ping", method: "ping" })
    send({ method: "notifications/message", params: { level: "info", data: "hello" } })
    return
  }
  if (message.method === "tools/list") {
    const cursor = message.params && message.params.cursor
    send({ id, result: cursor === "2" ? { tools: page2 } : { tools: page1, nextCursor: "2" } })
    return
  }
  if (message.method === "tools/call") {
    const name = message.params.name
    if (name === "get_issue") {
      send({ id, result: { content: [{ type: "text", text: issue }, { type: "image", data: "", mimeType: "image/png" }] } })
    } else if (name === "no_hint") {
      send({ id, result: text("ok") })
    } else if (name === "slow") {
      return
    } else if (name === "crash") {
      process.exit(3)
    } else if (name === "env") {
      send({ id, result: text(Object.keys(process.env).sort().join(",")) })
    } else if (name === "fail") {
      send({ id, result: { ...text("issue not found"), isError: true } })
    } else {
      send({ id, error: { code: -32602, message: "Unknown tool " + name } })
    }
    return
  }
  send({ id, error: { code: -32601, message: "Method not found" } })
}
`;

/** Writes the server script into `dir` and returns its path. */
export function writeFakeMcpServer(dir: string): string {
  const path = join(dir, "fake_mcp_server.mjs");
  writeTextFileSync(path, SCRIPT);
  return path;
}
