/** Fixture directory hashing for plan §15.3. */

export async function hashRemoteFixtures(version: number): Promise<string> {
  const dir = new URL(`./fixtures/v${version}/`, import.meta.url);
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      names.push(entry.name);
    }
  }
  names.sort();
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const name of names) {
    chunks.push(enc.encode(`${name}\n`));
    chunks.push(await Deno.readFile(new URL(name, dir)));
    chunks.push(enc.encode("\n"));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
