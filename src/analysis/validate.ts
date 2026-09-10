import type { Source } from "../types.ts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export async function validateSkill(
  markdown: string,
  outputDirectory: string,
  source?: Source,
): Promise<ValidationResult> {
  const errors: string[] = [];
  if (!markdown.startsWith("---\n")) errors.push("missing YAML frontmatter");
  if (!/^name:\s+\S+/m.test(markdown)) errors.push("missing frontmatter name");
  if (!/^description:\s+\S+/m.test(markdown)) {
    errors.push("missing frontmatter description");
  }
  if (!/^#\s+\S+/m.test(markdown)) errors.push("missing skill heading");
  if (markdown.includes("```")) {
    errors.push("skill contains an unrequested code fence");
  }
  if (!(markdown.match(/^##\s+.+$/gm) ?? []).length) {
    errors.push("skill has no Markdown sections");
  }
  for (const section of markdown.split(/^##\s+/m).slice(1)) {
    const bullets = section.match(/^-\s+/gm) ?? [];
    if (bullets.length > 6) {
      errors.push("section exceeds six bullets");
    }
    if (section.split("\n").some((line) => /^\s*[-*+]\s*$/.test(line))) {
      errors.push("skill contains an incomplete bullet");
    }
  }
  if ((markdown.match(/^\|.*\|$/gm) ?? []).length >= 3) {
    errors.push("skill contains a raw Markdown table");
  }

  if (source) {
    const paths = new Set([...source.tree, ...Object.keys(source.files)]);
    const repositoryName = String(source.repo.full_name ?? "");
    const commands = new Set<string>();
    for (const [path, content] of Object.entries(source.files)) {
      if (path.endsWith("package.json")) {
        try {
          const scripts =
            (JSON.parse(content) as { scripts?: Record<string, string> })
              .scripts ?? {};
          const prefix = source.tree.some((item) =>
              /pnpm-lock\.yaml$/.test(item)
            )
            ? "pnpm"
            : source.tree.some((item) => /yarn\.lock$/.test(item))
            ? "yarn"
            : "npm";
          for (const name of Object.keys(scripts)) {
            commands.add(`${prefix} ${name}`);
            commands.add(`${prefix} run ${name}`);
            commands.add(String(scripts[name]));
          }
        } catch {
          // Ignore malformed manifests; syntax validation is outside this gate.
        }
      }
      if (/deno\.jsonc?$/.test(path)) {
        try {
          const tasks =
            (JSON.parse(content) as { tasks?: Record<string, string> })
              .tasks ?? {};
          for (const name of Object.keys(tasks)) {
            commands.add(`deno task ${name}`);
          }
        } catch {
          // Ignore malformed manifests; syntax validation is outside this gate.
        }
      }
      for (const match of content.matchAll(/^\s*run:\s*([^\s#].*?)\s*$/gm)) {
        commands.add(match[1].replace(/^['"]|['"]$/g, ""));
      }
      for (
        const match of content.matchAll(
          /`((?:npm|pnpm|yarn|bun|deno|cargo|make|go|python|node|git)\s+[^`\n]+)`/g,
        )
      ) {
        commands.add(match[1]);
      }
      for (
        const match of content.matchAll(
          /^\s*((?:npm|pnpm|yarn|bun|deno|cargo|make|go|python|node|git)\s+[^\n`]+)$/gm,
        )
      ) {
        commands.add(match[1].trim());
      }
    }
    if (source.tree.some((path) => /Cargo\.toml$/.test(path))) {
      commands.add("cargo test");
      commands.add("cargo build");
    }
    const references = [
      ...markdown.matchAll(/`([^`\n]+)`/g),
    ].map((match) => match[1]);
    for (const reference of references) {
      const isQualifier = /^[a-z][a-z\d_-]*:/i.test(reference);
      if (
        reference.includes("/") &&
        !reference.startsWith("@") &&
        !reference.startsWith("http") &&
        !isQualifier &&
        !reference.startsWith("./") &&
        !reference.includes(" ")
      ) {
        const normalized = reference.replace(/^\.\/+/, "").replace(/^\/+/, "")
          .replace(/\/+$/, "");
        if (normalized === repositoryName) continue;
        const wildcardPattern = normalized.includes("*")
          ? new RegExp(
            `^${
              normalized.split("*").map((part) =>
                part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              ).join(".*")
            }$`,
          )
          : undefined;
        if (
          !paths.has(normalized) &&
          ![...paths].some((path) =>
            wildcardPattern
              ? wildcardPattern.test(path)
              : path.startsWith(`${normalized}/`)
          )
        ) {
          errors.push(`referenced path is absent from source: ${reference}`);
        }
      }
      if (
        /^(?:npm|pnpm|yarn|bun|deno|cargo|make|go|python|node|git)\s/.test(
          reference,
        ) &&
        ![...commands].some((command) =>
          reference === command ||
          reference.startsWith(`${command} `) ||
          command.startsWith(`${reference} `)
        )
      ) {
        errors.push(`referenced command is absent from source: ${reference}`);
      }
    }
  }

  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) =>
    match[1]
  );
  for (const link of links) {
    if (
      /^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("/") ||
      link.includes("..")
    ) {
      errors.push(`link is not relative: ${link}`);
      continue;
    }
    try {
      await Deno.stat(`${outputDirectory}/${link}`);
    } catch {
      errors.push(`linked file does not exist: ${link}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
