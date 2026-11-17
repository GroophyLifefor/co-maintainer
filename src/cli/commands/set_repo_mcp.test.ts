/** `set --repo --mcp-config` stores a repository's MCP servers, never prints
 * their env, is refused with `CM_MCP_DISABLED=1`, and `--mcp-allow-forks`
 * stores the fork rule. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
  writeTextFileSync,
} from "../../testing/runtime.ts";
import { renderCommandHelp } from "./registry.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

isolateTestFile();

/** Runs `fn` with a config file in a temporary directory, which is removed
 * however `fn` ends. */
async function withConfig(fn: (dir: string) => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  let dir: string | undefined;
  try {
    dir = tempDirSync();
    setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
    await fn(dir);
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `set` and returns what it printed. */
async function printed(args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...items: unknown[]) => lines.push(items.join(" "));
  try {
    await runSet(args);
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

const REPO = "--repo=acme/widgets";
const FILE = {
  mcpServers: {
    tracker: {
      command: "node",
      args: ["/opt/tracker-mcp/server.js"],
      env: { TRACKER_TOKEN: "very-secret-token-value" },
      tools: ["get_issue", "search_issues"],
    },
  },
};

test("--mcp-config stores the servers and prints names, never env", async () => {
  await withConfig(async (dir) => {
    const path = join(dir, "mcp.json");
    writeTextFileSync(path, JSON.stringify(FILE));
    const out = await printed([REPO, `--mcp-config=${path}`]);
    assert.ok(out.includes("mcpServers=tracker (get_issue, search_issues)"));
    assert.ok(!out.includes("very-secret-token-value"));
    assert.ok(!out.includes("/opt/tracker-mcp"));
    const stored = readConfig().repos?.["acme/widgets"]?.mcpServers;
    assert.deepEqual(stored, FILE.mcpServers);
    await runSet([REPO, "--unset=mcp-config"]);
    assert.equal(readConfig().repos?.["acme/widgets"]?.mcpServers, undefined);
  });
});

test("a file without tools or that cannot be read is refused", async () => {
  await withConfig(async (dir) => {
    const path = join(dir, "mcp.json");
    writeTextFileSync(
      path,
      JSON.stringify({ mcpServers: { tracker: { command: "node" } } }),
    );
    await assert.rejects(
      runSet([REPO, `--mcp-config=${path}`]),
      /--mcp-config: Server tracker needs tools/,
    );
    await assert.rejects(
      runSet([REPO, `--mcp-config=${join(dir, "missing.json")}`]),
      /Could not read the MCP config/,
    );
    const big = join(dir, "big.json");
    writeTextFileSync(big, " ".repeat(1024 * 1024 + 1));
    await assert.rejects(runSet([REPO, `--mcp-config=${big}`]), /is over 1 MB/);
    assert.equal(readConfig().repos?.["acme/widgets"]?.mcpServers, undefined);
  });
});

test("CM_MCP_DISABLED=1 refuses --mcp-config", async () => {
  await withConfig(async (dir) => {
    const path = join(dir, "mcp.json");
    writeTextFileSync(path, JSON.stringify(FILE));
    const saved = getEnv("CM_MCP_DISABLED");
    setEnv("CM_MCP_DISABLED", "1");
    try {
      await assert.rejects(
        runSet([REPO, `--mcp-config=${path}`]),
        /MCP servers are turned off on this machine \(CM_MCP_DISABLED=1\)/,
      );
    } finally {
      if (saved === undefined) deleteEnv("CM_MCP_DISABLED");
      else setEnv("CM_MCP_DISABLED", saved);
    }
    assert.equal(readConfig().repos?.["acme/widgets"]?.mcpServers, undefined);
  });
});

test("--mcp-allow-forks takes true or false and can be unset", async () => {
  await withConfig(async () => {
    await runSet([REPO, "--mcp-allow-forks=true"]);
    assert.equal(readConfig().repos?.["acme/widgets"]?.mcpAllowForks, true);
    await assert.rejects(
      runSet([REPO, "--mcp-allow-forks=yes"]),
      /must be true or false/,
    );
    await runSet([REPO, "--unset=mcp-allow-forks"]);
    assert.equal(
      readConfig().repos?.["acme/widgets"]?.mcpAllowForks,
      undefined,
    );
  });
});

test("both flags need --repo and are in the help", async () => {
  await assert.rejects(
    runSet(["--mcp-config=./mcp.json"]),
    /--mcp-config needs --repo/,
  );
  const help = renderCommandHelp("set") ?? "";
  assert.ok(help.includes("--mcp-config"));
  assert.ok(help.includes("--mcp-allow-forks"));
});
