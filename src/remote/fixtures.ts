/** Fixture directory hashing for plan §15.3.
 *
 * The hash exists to catch schema/content drift in the wire fixtures, not
 * line-ending drift, so `\r\n` is normalized to `\n` before hashing. Without
 * that the digest depends on the checkout: `.gitattributes` keeps the repo at
 * LF, but a Windows working tree with `autocrlf` hands the test CRLF and a
 * different digest. */
import { readDir, readFile } from "../util/runtime.ts";

export async function hashRemoteFixtures(version: number): Promise<string> {
  const dir = new URL(`./fixtures/v${version}/`, import.meta.url);
  const names: string[] = [];
  for await (const entry of readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      names.push(entry.name);
    }
  }
  names.sort();
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const name of names) {
    chunks.push(enc.encode(`${name}\n`));
    const raw = dec.decode(await readFile(new URL(name, dir)));
    chunks.push(enc.encode(raw.replace(/\r\n/g, "\n")));
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
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
