function die(message: string): never {
  throw new Error(message);
}

const TRAEFIK_DYNAMIC_DIR = "/etc/traefik/dynamic";

function traefikConfig(name: string, domain: string, port: number): string {
  return `http:
  routers:
    ${name}:
      rule: "Host(\`${domain}\`)"
      entryPoints: [websecure]
      service: ${name}
      tls: {}
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:${port}"
`;
}

const TRAEFIK_STATIC_CONFIGS = [
  "/etc/traefik/traefik.yml",
  "/etc/traefik/traefik.yaml",
  "/etc/traefik/traefik.toml",
];

/** Best-effort: if a Traefik static config file exists and has no
 * `providers` section at all yet, append a file-provider block pointing at
 * TRAEFIK_DYNAMIC_DIR so the route we're about to write actually gets
 * picked up. Deliberately does nothing (just prints guidance) when a
 * `providers` section already exists — merging into arbitrary existing
 * YAML/TOML without a real parser risks corrupting it (e.g. duplicating a
 * top-level key), and this never touches or restarts the running Traefik
 * process either way; a config edit still needs a manual reload. */
async function ensureTraefikFileProvider(): Promise<void> {
  for (const path of TRAEFIK_STATIC_CONFIGS) {
    let content: string;
    try {
      content = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    if (/^\s*\[?providers\b/m.test(content)) {
      if (!content.includes(TRAEFIK_DYNAMIC_DIR)) {
        console.log(
          `[serve] ${path} already has a providers section but doesn't mention ${TRAEFIK_DYNAMIC_DIR} — ` +
            `add a file provider for it manually, then reload Traefik:\n` +
            (path.endsWith(".toml")
              ? `  [providers.file]\n    directory = "${TRAEFIK_DYNAMIC_DIR}"\n    watch = true`
              : `  file:\n    directory: ${TRAEFIK_DYNAMIC_DIR}\n    watch: true`),
        );
      }
      return;
    }
    const block = path.endsWith(".toml")
      ? `\n[providers.file]\n  directory = "${TRAEFIK_DYNAMIC_DIR}"\n  watch = true\n`
      : `\nproviders:\n  file:\n    directory: ${TRAEFIK_DYNAMIC_DIR}\n    watch: true\n`;
    try {
      await Deno.writeTextFile(path, `${content}${block}`);
      console.log(
        `[serve] added a file provider to ${path} — reload/restart Traefik once to pick it up`,
      );
    } catch (error) {
      console.log(
        `[serve] could not update ${path} (${
          String(error)
        }); add the file provider manually`,
      );
    }
    return;
  }
  console.log(
    `[serve] no Traefik static config file found at ${
      TRAEFIK_STATIC_CONFIGS.join(", ")
    } — ` +
      `it may be configured via CLI flags or a container's command; make sure ` +
      `its file provider watches ${TRAEFIK_DYNAMIC_DIR}`,
  );
}

/** `co-maintainer serve --port=N --domain=host` — placeholder HTTP server,
 * exposed behind Traefik: writes a dynamic-config route for `domain` ->
 * `127.0.0.1:port` on start, and removes it again on exit (Ctrl+C, a
 * signal, or a thrown error) so a killed server never leaves a dangling
 * route pointing at nothing. */
export async function runServe(args: string[]): Promise<void> {
  const portArg = args.find((arg) => arg.startsWith("--port="))?.slice(
    "--port=".length,
  );
  if (!portArg) die("--port is required, e.g. --port=5000");
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    die("--port must be an integer between 1 and 65535");
  }

  const domain = args.find((arg) => arg.startsWith("--domain="))?.slice(
    "--domain=".length,
  );
  if (!domain) {
    die("--domain is required, e.g. --domain=co-maintainer.example.com");
  }
  if (/\s/.test(domain) || domain.includes("/")) {
    die("--domain must be a bare hostname, e.g. co-maintainer.example.com");
  }

  await ensureTraefikFileProvider();

  const name = `co-maintainer-${port}`;
  const configPath = `${TRAEFIK_DYNAMIC_DIR}/${name}.yml`;
  try {
    await Deno.mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    await Deno.writeTextFile(configPath, traefikConfig(name, domain, port));
  } catch (error) {
    die(
      `Could not write Traefik route to ${configPath}: ${
        String(error)
      }. Run as a user that can write to ${TRAEFIK_DYNAMIC_DIR}.`,
    );
  }
  console.log(`[serve] routed https://${domain} -> 127.0.0.1:${port} (${configPath})`);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Deno.remove(configPath).catch(() => {});
    console.log(`[serve] removed ${configPath}`);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, async () => {
        await cleanup();
        Deno.exit(0);
      });
    } catch {
      // Not every signal is supported on every platform (e.g. SIGTERM on
      // Windows); the exit/finally path below still covers cleanup.
    }
  }

  try {
    const server = Deno.serve({ port }, () => new Response("hello"));
    console.log(`[serve] listening on http://localhost:${port}`);
    await server.finished;
  } finally {
    await cleanup();
  }
}
