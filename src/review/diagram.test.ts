import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  DiagramSettingError,
  diagramOptionsFrom,
  diagramRuntimeProblem,
  diagramSettings,
  encodePlantuml,
  mermaidToolFields,
  plantumlFormatProblem,
  plantumlImageUrl,
  plantumlPromptRules,
  plantumlReplyRules,
  plantumlServerProblem,
  plantumlSystemRules,
  renderDiagrams,
} from "./diagram.ts";
import type { DiagramOptions } from "./diagram.ts";
import { redact } from "../util/redact.ts";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** The inverse of the encoder, written from the PlantUML decoding rules, so a
 * round trip proves the URL path says what the source said. */
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

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function throwsSetting(fn: () => unknown, part: string): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof DiagramSettingError)) throw error;
    if (!error.message.includes(part)) {
      throw new Error(`message lacks "${part}": ${error.message}`);
    }
    return;
  }
  throw new Error(`did not throw for "${part}"`);
}

const SERVER: DiagramOptions = {
  diagramRuntime: "plantuml-server",
  plantumlServer: "https://uml.example.com",
  plantumlOutputFormat: "svg",
};

const SAMPLE = "@startuml\nBob -> Alice : hello\n@enduml";

test("the encoding decodes back to the source, with non-ASCII text intact", () => {
  for (const source of [
    SAMPLE,
    "@startuml\nA -> B : héllo ünï 日本\n@enduml",
    `@startuml\n${"x -> y : long line\n".repeat(200)}@enduml`,
    "a",
  ]) {
    same(decode(encodePlantuml(source)), source, "round trip");
  }
});

test("the issue's own example URL decodes to the same source", () => {
  same(
    decode("SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW80"),
    SAMPLE,
    "issue example",
  );
});

test("the encoding uses only the PlantUML alphabet", () => {
  const code = encodePlantuml(SAMPLE.repeat(40));
  if (!/^[0-9A-Za-z_-]+$/.test(code)) throw new Error(code);
});

test("the public server is addressed under /plantuml", () => {
  const url = plantumlImageUrl(
    "Bob -> Alice : hello",
    "https://www.plantuml.com",
    "svg",
  );
  if (!url.startsWith("https://www.plantuml.com/plantuml/svg/")) {
    throw new Error(url);
  }
  same(decode(url.split("/svg/")[1]!), SAMPLE, "wrapped source");
});

test("a server the user runs is addressed exactly as given", () => {
  const prefix = (server: string, format: "svg" | "png") =>
    plantumlImageUrl(SAMPLE, server, format).replace(
      /\/(svg|png)\/[^/]+$/,
      "/$1/",
    );
  same(
    prefix("http://localhost:8080", "png"),
    "http://localhost:8080/png/",
    "root",
  );
  same(
    prefix("http://localhost:8080/", "svg"),
    "http://localhost:8080/svg/",
    "slash",
  );
  same(
    prefix("https://ci.example.com/plantuml/", "svg"),
    "https://ci.example.com/plantuml/svg/",
    "sub path",
  );
  same(
    prefix("https://www.plantuml.com/", "png"),
    "https://www.plantuml.com/plantuml/png/",
    "public slash",
  );
});

test("source that already has start markers is not wrapped twice", () => {
  const url = plantumlImageUrl(SAMPLE, "https://uml.example.com", "svg");
  same(decode(url.split("/svg/")[1]!), SAMPLE, "source");
});

test("a server must be an http or https URL", () => {
  same(plantumlServerProblem("https://www.plantuml.com"), null, "https");
  same(plantumlServerProblem("http://localhost:8080/plantuml"), null, "http");
  for (const bad of [
    "",
    "plantuml.com",
    "ftp://plantuml.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@plantuml.com",
    "https://plantuml.com/?a=1",
    "https://plantuml.com/#x",
  ]) {
    if (plantumlServerProblem(bad) === null) throw new Error(`accepted ${bad}`);
  }
});

test("runtime and format names are checked", () => {
  for (const ok of ["mermaid", "plantuml", "plantuml-server"]) {
    same(diagramRuntimeProblem(ok), null, ok);
  }
  if (diagramRuntimeProblem("graphviz") === null) throw new Error("graphviz");
  same(plantumlFormatProblem("svg"), null, "svg");
  same(plantumlFormatProblem("png"), null, "png");
  if (plantumlFormatProblem("gif") === null) throw new Error("gif");
});

test("a repository that sets nothing keeps the Options it always had", () => {
  same(JSON.stringify(diagramOptionsFrom({})), "{}", "empty");
  same(JSON.stringify(diagramOptionsFrom({}, {})), "{}", "empty repo");
  const defaults = diagramSettings(undefined);
  same(defaults.runtime, "mermaid", "runtime");
  same(defaults.server, "https://www.plantuml.com", "server");
  same(defaults.format, "svg", "format");
});

test("a flag wins over the repository's stored value", () => {
  const options = diagramOptionsFrom(
    { runtime: "plantuml", format: "png" },
    {
      diagramRuntime: "plantuml-server",
      plantumlServer: "https://uml.example.com",
      plantumlOutputFormat: "svg",
    },
    "acme/widgets",
  );
  same(options.diagramRuntime, "plantuml", "runtime");
  same(options.plantumlOutputFormat, "png", "format");
  same(options.plantumlServer, "https://uml.example.com", "server");
});

test("a bad flag names the flag", () => {
  throwsSetting(
    () => diagramOptionsFrom({ runtime: "graphviz" }),
    "--diagram-runtime must be one of: mermaid, plantuml, plantuml-server",
  );
  throwsSetting(
    () => diagramOptionsFrom({ server: "ftp://x" }),
    "--plantuml-server must be an http or https URL",
  );
  throwsSetting(
    () => diagramOptionsFrom({ format: "gif" }),
    "--plantuml-output-format must be one of: svg, png",
  );
  throwsSetting(() => diagramOptionsFrom({ runtime: "" }), "--diagram-runtime");
});

test("a bad stored value names the repository and the field", () => {
  throwsSetting(
    () =>
      diagramOptionsFrom(
        {},
        { plantumlServer: "ftp://old.example.com" },
        "acme/widgets",
      ),
    "repos[acme/widgets].plantumlServer must be an http or https URL",
  );
});

test("a server setting is checked even when the runtime ignores it", () => {
  throwsSetting(
    () => diagramOptionsFrom({ runtime: "mermaid", server: "nope" }),
    "--plantuml-server",
  );
});

test("mermaid and plantuml leave every block exactly as written", () => {
  const text =
    "Intro\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n\n```mermaid\nflowchart LR\n```\n";
  same(renderDiagrams(text, undefined), text, "default");
  same(renderDiagrams(text, { diagramRuntime: "mermaid" }), text, "mermaid");
  same(renderDiagrams(text, { diagramRuntime: "plantuml" }), text, "plantuml");
});

test("plantuml-server turns a PlantUML block into an image link", () => {
  const text =
    "Before\n\n```plantuml\n@startuml\nBob -> Alice : hello\n@enduml\n```\n\nAfter\n";
  const out = renderDiagrams(text, SERVER);
  const match =
    /^!\[PlantUML diagram\]\((https:\/\/uml\.example\.com\/svg\/([^)]+))\)$/m.exec(
      out,
    );
  if (!match) throw new Error(out);
  same(decode(match[2]!), SAMPLE, "decoded");
  if (out.includes("```")) throw new Error("fence left behind");
  if (!out.startsWith("Before\n\n") || !out.endsWith("\n\nAfter\n")) {
    throw new Error(`surrounding text changed: ${JSON.stringify(out)}`);
  }
});

test("the output format picks the path", () => {
  const out = renderDiagrams("```plantuml\nA -> B\n```", {
    ...SERVER,
    plantumlOutputFormat: "png",
  });
  if (!out.includes("https://uml.example.com/png/")) throw new Error(out);
});

test("the default server is the public one under /plantuml", () => {
  const out = renderDiagrams("```plantuml\nA -> B\n```", {
    diagramRuntime: "plantuml-server",
  });
  if (!out.includes("](https://www.plantuml.com/plantuml/svg/")) {
    throw new Error(out);
  }
});

test("plantuml-server converts several blocks, tilde fences and the puml tag", () => {
  const text = [
    "~~~PlantUML",
    "A -> B",
    "~~~",
    "text",
    "````puml",
    "@startuml",
    "C -> D",
    "```",
    "@enduml",
    "````",
  ].join("\n");
  const out = renderDiagrams(text, SERVER);
  const links = out.match(/!\[PlantUML diagram\]\(/g) ?? [];
  same(links.length, 2, "links");
  if (out.includes("~~~") || out.includes("````")) throw new Error(out);
});

test("plantuml-server keeps an indented block's indent", () => {
  const out = renderDiagrams(
    "- item\n  ```plantuml\n  A -> B\n  ```\n",
    SERVER,
  );
  if (!/^ {2}!\[PlantUML diagram\]\(/m.test(out)) throw new Error(out);
});

test("plantuml-server leaves other fences and an unclosed block alone", () => {
  const other = "```mermaid\nflowchart LR\n```\n\n```ts\nconst a = 1;\n```\n";
  same(renderDiagrams(other, SERVER), other, "other fences");
  const open = "```plantuml\n@startuml\nA -> B\n";
  same(renderDiagrams(open, SERVER), open, "unclosed");
  const empty = "```plantuml\n```\n";
  same(renderDiagrams(empty, SERVER), empty, "empty block");
});

test("plantuml-server keeps the source when the link would be too long", () => {
  // Random lines do not deflate, so the link outgrows what a server accepts.
  let seed = 7;
  const noise = Array.from({ length: 900 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return `N${seed.toString(36)} -> M${(seed * 31).toString(36)}`;
  }).join("\n");
  const text = `\`\`\`plantuml\n@startuml\n${noise}\n@enduml\n\`\`\`\n`;
  same(renderDiagrams(text, SERVER), text, "long block");
});

test("plantuml-server handles Windows line endings", () => {
  const out = renderDiagrams("```plantuml\r\nA -> B\r\n```\r\n", SERVER);
  if (!out.includes("![PlantUML diagram](")) throw new Error(out);
});

test("PlantUML wording exists only for a PlantUML runtime", () => {
  for (const rules of [
    plantumlSystemRules,
    plantumlPromptRules,
    plantumlReplyRules,
  ]) {
    same(rules(undefined), undefined, "default");
    same(rules({ diagramRuntime: "mermaid" }), undefined, "mermaid");
  }
  for (const runtime of ["plantuml", "plantuml-server"] as const) {
    const options = { diagramRuntime: runtime };
    for (const rules of [
      plantumlSystemRules,
      plantumlPromptRules,
      plantumlReplyRules,
    ]) {
      const text = rules(options);
      if (!text || !/PlantUML/.test(text)) throw new Error(String(text));
      if (/read-mermaid-syntaxes|Mermaid/.test(text)) {
        throw new Error(`mermaid wording leaked: ${text}`);
      }
    }
  }
});

test("both PlantUML runtimes ask for the same standard source", () => {
  same(
    plantumlSystemRules({ diagramRuntime: "plantuml" }),
    plantumlSystemRules({ diagramRuntime: "plantuml-server" }),
    "system",
  );
  const text = plantumlSystemRules({ diagramRuntime: "plantuml-server" })!;
  if (!text.includes("@startuml") || !text.includes("server URL")) {
    throw new Error("the model must be told to write source, not links");
  }
});

test("PlantUML wording follows the prose rules", () => {
  const options = { diagramRuntime: "plantuml" } as const;
  for (const text of [
    plantumlSystemRules(options)!,
    plantumlPromptRules(options)!,
    plantumlReplyRules(options)!,
  ]) {
    if (text.includes("—")) throw new Error("em dash");
    if (/[a-z]; [a-z]/.test(text)) throw new Error("semicolon in prose");
  }
});

test("only a PlantUML runtime drops the Mermaid tool", () => {
  same(JSON.stringify(mermaidToolFields(undefined)), "{}", "default");
  same(
    JSON.stringify(mermaidToolFields({ diagramRuntime: "mermaid" })),
    "{}",
    "mermaid",
  );
  same(
    mermaidToolFields({ diagramRuntime: "plantuml" }).withoutMermaidTool,
    true,
    "plantuml",
  );
  same(
    mermaidToolFields({ diagramRuntime: "plantuml-server" }).withoutMermaidTool,
    true,
    "plantuml-server",
  );
});

test("a link the secret redactor would cut is encoded again", () => {
  // Base64 spells a key-shaped string once in a while, in a long enough link
  // roughly one in two thousand. Search for such a diagram with a fixed seed.
  let seed = 1;
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
    const source = Array.from(
      { length: 6 },
      () => `${word()} -> ${word()} : ${word()}`,
    ).join("\n");
    const url = plantumlImageUrl(source, SERVER.plantumlServer!, "svg");
    if (redact(url) !== url) found = source;
  }
  if (found === undefined) throw new Error("no key-shaped link was found");
  const out = renderDiagrams(`\`\`\`plantuml\n${found}\n\`\`\``, SERVER);
  const url = /\]\(([^)]+)\)/.exec(out)?.[1];
  if (!url) throw new Error(out);
  same(redact(url), url, "the link survives the redactor");
  // Only blank lines after the end marker were added.
  const decoded = decode(url.split("/svg/")[1]!);
  same(decoded.trimEnd(), `@startuml\n${found}\n@enduml`, "same diagram");
});
