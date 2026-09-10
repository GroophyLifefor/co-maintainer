function die(message: string): never {
  throw new Error(message);
}

/** `co-maintainer serve --port=N` — placeholder HTTP server. */
export async function runServe(args: string[]): Promise<void> {
  const portArg = args.find((arg) => arg.startsWith("--port="))?.slice(
    "--port=".length,
  );
  if (!portArg) die("--port is required, e.g. --port=5000");
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    die("--port must be an integer between 1 and 65535");
  }

  const server = Deno.serve({ port }, () => new Response("hello"));
  console.log(`[serve] listening on http://localhost:${port}`);
  await server.finished;
}
