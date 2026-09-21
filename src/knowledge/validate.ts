import type { Source } from "./types.ts";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export async function validateSkill(
  markdown: string,
  source?: Source,
  referenceIssues: "error" | "warning" = "error",
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const referenceProblems = referenceIssues === "error" ? errors : warnings;
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
    const references = [...markdown.matchAll(/`([^`\n]+)`/g)].map(
      (match) => match[1],
    );
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
        const normalized = reference
          .replace(/^\.\/+/, "")
          .replace(/^\/+/, "")
          .replace(/\/+$/, "");
        if (normalized === repositoryName) continue;
        const wildcardPattern = normalized.includes("*")
          ? new RegExp(
              `^${normalized
                .split("*")
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join(".*")}$`,
            )
          : undefined;
        if (
          !paths.has(normalized) &&
          ![...paths].some((path) =>
            wildcardPattern
              ? wildcardPattern.test(path)
              : path.startsWith(`${normalized}/`),
          )
        ) {
          referenceProblems.push(
            `referenced path is absent from source: ${reference}`,
          );
        }
      }
    }
  }

  for (const link of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = link[1];
    if (
      /^[a-z][a-z\d+.-]*:/i.test(target) ||
      target.startsWith("/") ||
      target.includes("..")
    ) {
      errors.push(`link is not relative: ${target}`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
