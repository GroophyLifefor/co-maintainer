/** Which server forms get which path, which paths are refused, and which
 * fences are left alone. */
import { test } from "node:test";
import {
  plantumlImageUrl,
  plantumlServerProblem,
  renderDiagrams,
} from "./diagram.ts";
import type { DiagramOptions } from "./diagram.ts";

const SERVER: DiagramOptions = {
  diagramRuntime: "plantuml-server",
  plantumlServer: "https://uml.example.com",
};

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const head = (server: string): string =>
  plantumlImageUrl("A -> B", server, "svg").replace(/\/svg\/[^/]+$/, "/svg/");

test("the public server gets /plantuml under every form of its address", () => {
  for (const [server, expected] of [
    ["https://www.plantuml.com", "https://www.plantuml.com/plantuml/svg/"],
    ["http://www.plantuml.com", "http://www.plantuml.com/plantuml/svg/"],
    ["https://plantuml.com", "https://plantuml.com/plantuml/svg/"],
    ["https://PlantUML.com/", "https://plantuml.com/plantuml/svg/"],
    ["https://www.plantuml.com:443", "https://www.plantuml.com/plantuml/svg/"],
    [
      "https://www.plantuml.com/plantuml",
      "https://www.plantuml.com/plantuml/svg/",
    ],
  ] as const) {
    same(head(server), expected, server);
  }
});

test("a different host that only looks like the public one is a custom server", () => {
  same(
    head("https://notplantuml.com"),
    "https://notplantuml.com/svg/",
    "suffix",
  );
  same(
    head("https://plantuml.com.example.org"),
    "https://plantuml.com.example.org/svg/",
    "prefix",
  );
});

test("a server path that would break a Markdown link is refused", () => {
  for (const bad of [
    "https://my.host/a)b",
    "https://my.host/a(b",
    "https://my.host/a]b",
    "https://my.host/a[b",
    "https://my.host/a;b",
    "https://my.host/a b",
  ]) {
    if (plantumlServerProblem(bad) === null) throw new Error(`accepted ${bad}`);
  }
  for (const good of [
    "https://my.host/plantuml",
    "http://[::1]:8080",
    "https://my.host:8443/uml/v1/",
    "https://my-host.example.com/a_b.c~d",
  ]) {
    same(plantumlServerProblem(good), null, good);
  }
});

test("a PlantUML block inside a suggestion is left alone", () => {
  const text =
    "Suggestion: `README.md:3`\n```suggestion\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n";
  same(renderDiagrams(text, SERVER), text, "suggestion");
});

test("a PlantUML block inside a longer fence is left alone", () => {
  const text =
    "Example:\n````markdown\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n````\n";
  same(renderDiagrams(text, SERVER), text, "four backticks");
  const tildes = "~~~markdown\n```plantuml\nA -> B\n```\n~~~\n";
  same(renderDiagrams(tildes, SERVER), tildes, "tildes");
});

test("a block after another fence is still converted", () => {
  const text =
    "```ts\nconst a = 1;\n```\n\n```plantuml\nA -> B\n```\n\n```suggestion\nx\n```\n";
  const out = renderDiagrams(text, SERVER);
  if (!out.includes("![PlantUML diagram](")) throw new Error(out);
  if (out.includes("```plantuml")) throw new Error(out);
  if (!out.includes("```ts\nconst a = 1;\n```")) throw new Error(out);
  if (!out.includes("```suggestion\nx\n```")) throw new Error(out);
});

test("text after an unclosed fence is not converted", () => {
  // Nothing closes the first fence, because a line with an info text cannot.
  // The whole tail belongs to it, the later tagged line included.
  const text = "Intro\n```plantuml\n@startuml\nA -> B\n\n```plantuml\nC -> D\n";
  same(renderDiagrams(text, SERVER), text, "unclosed");
});

test("a link of 4000 characters is kept and a longer one falls back to the source", () => {
  let seed = 11;
  const line = () => {
    let text = "";
    for (let i = 0; i < 12; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += String.fromCharCode(97 + ((seed >> 8) % 26));
    }
    return `${text} -> ${text.split("").reverse().join("")}`;
  };
  const lines: string[] = [];
  const urlLength = () =>
    plantumlImageUrl(
      `@startuml\n${lines.join("\n")}\n@enduml`,
      "https://uml.example.com",
      "svg",
    ).length;
  while (urlLength() <= 4000) lines.push(line());
  const over = lines.join("\n");
  const under = lines.slice(0, -1).join("\n");
  if (urlLength() <= 4000) throw new Error("the search did not pass the cap");
  const block = (source: string) =>
    `\`\`\`plantuml\n@startuml\n${source}\n@enduml\n\`\`\``;
  const kept = renderDiagrams(block(under), SERVER);
  if (!kept.startsWith("![PlantUML diagram](")) throw new Error(kept);
  if (kept.length - "![PlantUML diagram]()".length > 4000) {
    throw new Error(`link of ${kept.length} characters`);
  }
  same(renderDiagrams(block(over), SERVER), block(over), "over the cap");
});

test("inline triple backticks are not a fence", () => {
  const text = "Use ```plantuml``` for diagrams.\n\n```plantuml\nA -> B\n```\n";
  const out = renderDiagrams(text, SERVER);
  if (!out.startsWith("Use ```plantuml``` for diagrams.")) throw new Error(out);
  if (!out.includes("![PlantUML diagram](")) throw new Error(out);
});
