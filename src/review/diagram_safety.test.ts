/** What may and may not end up in a PlantUML image link. */
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { plantumlImageUrl, renderDiagrams } from "./diagram.ts";
import type { DiagramOptions } from "./diagram.ts";
import { redact } from "../util/redact.ts";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function decode(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => ALPHABET.indexOf(encoded[i + k]!));
    bytes.push(
      (v[0]! << 2) | (v[1]! >> 4),
      ((v[1]! & 15) << 4) | (v[2]! >> 2),
      ((v[2]! & 3) << 6) | v[3]!,
    );
  }
  return inflateRawSync(Buffer.from(bytes)).toString("utf8");
}

const SERVER: DiagramOptions = {
  diagramRuntime: "plantuml-server",
  plantumlServer: "https://uml.example.com",
  plantumlOutputFormat: "svg",
};

const TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

function linkOf(markdown: string): string {
  const url = /!\[PlantUML diagram\]\(([^)]+)\)/.exec(markdown)?.[1];
  if (!url) throw new Error(`no link in: ${markdown}`);
  return url;
}

test("a token in the diagram source is cut before it is encoded", () => {
  const out = renderDiagrams(
    `\`\`\`plantuml\n@startuml\nCI -> GitHub : token ${TOKEN}\n@enduml\n\`\`\``,
    SERVER,
  );
  const source = decode(linkOf(out).split("/svg/")[1]!);
  if (source.includes(TOKEN) || source.includes("ghp_")) {
    throw new Error(`the token is in the link: ${source}`);
  }
  if (!source.includes("[redacted]")) throw new Error(source);
  if (out.includes(TOKEN)) throw new Error(out);
});

test("other secret shapes in the source are cut too", () => {
  for (const secret of [
    "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv",
  ]) {
    const out = renderDiagrams(
      `\`\`\`plantuml\nA -> B : ${secret}\n\`\`\``,
      SERVER,
    );
    const source = decode(linkOf(out).split("/svg/")[1]!);
    if (source.includes(secret)) throw new Error(`${secret} survived`);
  }
});

test("the re-encoding for a key-shaped link never brings a secret back", () => {
  let seed = 3;
  const word = () => {
    let text = "";
    for (let i = 0; i < 10; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += String.fromCharCode(97 + ((seed >> 8) % 26));
    }
    return text;
  };
  let found: string | undefined;
  for (let n = 0; n < 60_000 && found === undefined; n++) {
    const body = Array.from(
      { length: 6 },
      () => `${word()} -> ${word()} : ${word()}`,
    ).join("\n");
    const source = `${body}\nCI -> GitHub : ${TOKEN}`;
    const url = plantumlImageUrl(
      redact(source),
      "https://uml.example.com",
      "svg",
    );
    if (redact(url) !== url) found = source;
  }
  if (found === undefined) throw new Error("no key-shaped link was found");
  const out = renderDiagrams(`\`\`\`plantuml\n${found}\n\`\`\``, SERVER);
  const url = linkOf(out);
  if (redact(url) !== url) throw new Error("the link would still be cut");
  const source = decode(url.split("/svg/")[1]!);
  if (source.includes(TOKEN)) throw new Error("the secret came back");
  if (!source.includes("[redacted]")) throw new Error(source);
});
