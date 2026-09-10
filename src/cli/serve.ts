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
