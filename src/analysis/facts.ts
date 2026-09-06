import type { Fact, Json, Options, Source } from "../types.ts";

function fact(
  sectionKey: string,
  claim: string,
  evidence: string,
  weight = 1,
): Fact {
  return {
    id: `${sectionKey}:${claim.toLowerCase().replaceAll(/\W+/g, "-")}`,
    sectionKey,
    claim,
    evidence: [evidence],
    weight,
    scope: "current",
    confidence: "high",
    status: "active",
  };
}

function add(facts: Map<string, Fact>, item: Fact): void {
  const existing = facts.get(item.id);
  if (!existing) facts.set(item.id, item);
  else {
    existing.weight += item.weight;
    existing.evidence = [...new Set([...existing.evidence, ...item.evidence])];
    if (existing.scope !== item.scope) {
      existing.scope = existing.scope === "current" || item.scope === "current"
        ? "current"
        : "repeated-history";
    }
    existing.confidence = existing.confidence === "high" ||
        item.confidence === "high"
      ? "high"
      : existing.confidence === "medium" || item.confidence === "medium"
      ? "medium"
      : "low";
  }
}

function counts(values: string[]): [string, number][] {
  const result = new Map<string, number>();
  for (const value of values.filter(Boolean)) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return [...result.entries()].sort((a, b) =>
    b[1] - a[1] || a[0].localeCompare(b[0])
  );
}

function packageScripts(content: string): [string, string][] {
  try {
    const scripts = (JSON.parse(content) as Json).scripts as Json | undefined;
    return scripts
      ? Object.entries(scripts).map((
        [name, command],
      ) => [name, String(command)])
      : [];
  } catch {
    return [];
  }
}

function markdownSections(content: string): [string, string][] {
  const sections: [string, string][] = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const summary = lines.join(" ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (heading && summary) {
      sections.push([heading, summary]);
    }
  };
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      flush();
      heading = match[1].trim();
      lines = [];
    } else if (heading && line.trim() && !line.trim().startsWith("```")) {
      lines.push(line.trim());
    }
  }
  flush();
  return sections;
}

function cargoPackage(content: string): string | undefined {
  return content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
}

function sourceModuleClaim(path: string, content: string): string | undefined {
  const symbols = [
    ...content.matchAll(
      /\b(?:pub\s+)?(?:struct|enum|trait|fn|function|class|interface|type|func|def|const)\s+([A-Za-z_]\w*)|\bexport\s+(?:default\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_]\w*)/g,
    ),
  ].map((match) => match[1] ?? match[2]).filter(Boolean).slice(0, 8);
  if (!symbols.length) return undefined;
  return `\`${path}\` contains ${
    symbols.map((symbol) => `\`${symbol}\``).join(", ")
  }; keep related changes in this module.`;
}

function commandPrefix(source: Source): string {
  if (source.tree.some((path) => /pnpm-lock\.yaml$/.test(path))) return "pnpm";
  if (source.tree.some((path) => /yarn\.lock$/.test(path))) return "yarn";
  if (source.tree.some((path) => /bun\.lockb?$/.test(path))) return "bun";
  if (source.tree.some((path) => /deno\.json(?:c)?$/.test(path))) {
    return "deno task";
  }
  if (source.tree.some((path) => /Cargo\.toml$/.test(path))) return "cargo";
  if (source.tree.some((path) => /Makefile$|makefile$/i.test(path))) {
    return "make";
  }
  return "npm run";
}

function sanitizeDocumentBody(body: string, source: Source): string {
  const paths = new Set([...source.tree, ...Object.keys(source.files)]);
  const repositoryName = String(source.repo.full_name ?? "");
  const known = (reference: string): boolean => {
    if (reference.startsWith("@") || reference === repositoryName) return true;
    const normalized = reference.replace(/^\.\/+/, "").replace(/\/+$/, "");
    const wildcard = normalized.includes("*")
      ? new RegExp(
        `^${
          normalized.split("*").map((part) =>
            part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          ).join(".*")
        }$`,
      )
      : undefined;
    return paths.has(normalized) ||
      [...paths].some((path) =>
        wildcard ? wildcard.test(path) : path.startsWith(`${normalized}/`)
      );
  };
  return body
    .replace(
      /`([^`\n]+\/[^`\n]+)`/g,
      (whole, reference: string) => known(reference) ? whole : "",
    )
    .replace(
      /(?:^|[\s("'`])((?!@)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*?{}<>:+-]+(?:\/[A-Za-z0-9_.*?{}<>:+-]+)*)/g,
      (whole, reference: string) =>
        known(reference) ? whole : whole.replace(reference, ""),
    );
}

export function extractFacts(source: Source, options: Options): Fact[] {
  const facts = new Map<string, Fact>();
  const fullName = String(source.repo.full_name ?? "");
  const branch = String(source.repo.default_branch ?? "main");
  add(
    facts,
    fact(
      "identity",
      `Work in ${fullName} on the \`${branch}\` default branch.`,
      "repository metadata",
      3,
    ),
  );

  const directories = [
    ...new Set(
      source.tree.map((path) => path.split("/")[0]).filter((path) =>
        path &&
        !path.includes(".") &&
        !/^(test|tests|spec|__tests__)$/i.test(path)
      ),
    ),
  ].sort();
  if (directories.length) {
    add(
      facts,
      fact(
        "layout",
        `Top-level directories include ${
          directories.slice(0, 12).map((dir) => `\`${dir}/\``).join(", ")
        }.`,
        "repository tree",
        2,
      ),
    );
  }
  const testRoots = [
    ...new Set(
      source.tree.map((path) => path.split("/")[0]).filter((root) =>
        /^(test|tests|spec|__tests__)$/i.test(root)
      ),
    ),
  ];
  if (testRoots.length) {
    add(
      facts,
      fact(
        "tests",
        `Repository tests live under ${
          testRoots.map((root) => `\`${root}/\``).join(", ")
        }.`,
        "repository tree",
        3,
      ),
    );
  }
  const workflows = source.tree.filter((path) =>
    /^\.github\/workflows\/.+\.(yml|yaml)$/i.test(path)
  );
  if (workflows.length) {
    add(
      facts,
      fact(
        "ship",
        `CI workflows are defined in ${
          workflows.map((path) => `\`${path}\``).join(", ")
        }.`,
        "repository tree",
        3,
      ),
    );
  }
  if (
    source.tree.some((path) =>
      /^\.github\/workflows\/.+release.+\.(yml|yaml)$/i.test(path) ||
      /(^|\/)(changesets|release-please|\.releaserc)/i.test(path)
    )
  ) {
    add(
      facts,
      fact(
        "ship",
        "The repository contains an explicit release workflow or release configuration.",
        "release files",
        3,
      ),
    );
  }

  const seenScripts = new Set<string>();
  for (const [path, content] of Object.entries(source.files)) {
    if (/^(?:src|lib|app|cmd)\//i.test(path)) {
      const claim = sourceModuleClaim(path, content);
      if (claim) add(facts, fact("layout", claim, path, 3));
    }
    if (/^README\.md$/i.test(path) || /CONTRIBUTING/i.test(path)) {
      for (const [heading, body] of markdownSections(content)) {
        const isReadme = /^README\.md$/i.test(path);
        const relevant = isReadme
          ? /usage|run|develop|build|test|contribut|release/i.test(heading)
          : /install|setup|usage|run|develop|build|test|contribut|release/i
            .test(
              heading,
            );
        if (!relevant) {
          continue;
        }
        add(
          facts,
          fact(
            "devloop",
            `README ${heading}: ${
              sanitizeDocumentBody(body, source).slice(0, 260)
            }${body.length > 260 ? "…" : ""}`,
            path,
            3,
          ),
        );
      }
    }
    if (/^Cargo\.toml$/i.test(path)) {
      const packageName = cargoPackage(content);
      add(
        facts,
        fact(
          "identity",
          `This is a Rust Cargo project${
            packageName ? ` named \`${packageName}\`` : ""
          }.`,
          path,
          4,
        ),
      );
      add(
        facts,
        fact("tests", "Run the Rust test suite with `cargo test`.", path, 3),
      );
    }
    if (/^CHANGELOG\.md$/i.test(path)) {
      add(
        facts,
        fact(
          "ship",
          "Release notes are maintained in `CHANGELOG.md`.",
          path,
          3,
        ),
      );
    }
    if (/PULL_REQUEST_TEMPLATE/i.test(path)) {
      add(
        facts,
        fact(
          "title-body",
          `Use the pull request template at \`${path}\`.`,
          path,
          4,
        ),
      );
      const headings = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)]
        .map((match) => match[1].trim()).slice(0, 12);
      if (headings.length) {
        add(
          facts,
          fact(
            "title-body",
            `The pull request template asks for: ${
              headings.map((heading) => `**${heading}**`).join(", ")
            }.`,
            path,
            4,
          ),
        );
      }
    }
    for (
      const [name, command] of path.endsWith("package.json")
        ? packageScripts(content)
        : []
    ) {
      const rootScript = path === "package.json";
      const usefulWorkspaceScript = /test|lint|check|type|build|load|compare/i
        .test(name);
      if (!rootScript && !usefulWorkspaceScript) continue;
      const cleanCommand = sanitizeDocumentBody(command, source).replace(
        /\s+/g,
        " ",
      ).trim();
      if (!cleanCommand) continue;
      const scriptKey = `${name}:${command}`;
      if (seenScripts.has(scriptKey)) continue;
      seenScripts.add(scriptKey);
      const section = /test|lint|check|type/i.test(name)
        ? "tests"
        : /build|dev|start|format/i.test(name)
        ? "devloop"
        : "ship";
      add(
        facts,
        fact(
          section,
          `Use \`${commandPrefix(source)} ${name}\` for ${cleanCommand}.`,
          path,
          2,
        ),
      );
    }
    if (/^\.github\/workflows\//.test(path)) {
      const jobsBlock =
        content.match(/^jobs:\s*\n([\s\S]*?)(?=^[^\s]|\s*$)/m)?.[1] ?? "";
      const jobs = [...jobsBlock.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)]
        .map((match) => match[1]).slice(0, 20);
      if (jobs.length) {
        add(
          facts,
          fact(
            "ship",
            `Workflow \`${path}\` defines jobs: ${
              jobs.map((job) => `\`${job}\``).join(", ")
            }.`,
            path,
            2,
          ),
        );
      }
      if (/\bon:\s*[\s\S]{0,200}\bpull_request\b/.test(content)) {
        add(
          facts,
          fact(
            "ship",
            `Changes targeting pull requests run \`${path}\`.`,
            path,
            3,
          ),
        );
      }
      if (/\bpush:\s*\n\s+branches:\s*\n\s+-\s*main\b/.test(content)) {
        add(
          facts,
          fact(
            "ship",
            `The release workflow runs when \`main\` receives a push.`,
            path,
            4,
          ),
        );
      }
      if (/runs-on:\s*windows-latest/i.test(content)) {
        add(
          facts,
          fact("ship", `Release builds run on \`windows-latest\`.`, path, 3),
        );
      }
      if (/cargo\s+build\s+--release/.test(content)) {
        add(
          facts,
          fact(
            "ship",
            "The release pipeline builds the Rust binary with `cargo build --release`.",
            path,
            4,
          ),
        );
      }
      if (/gh\s+release\s+create/.test(content)) {
        add(
          facts,
          fact(
            "ship",
            "Publishing uses `gh release create` with a generated version tag and `CHANGELOG.md` notes.",
            path,
            4,
          ),
        );
      }
      if (/Cargo\.toml/.test(content) && /version\s*=/i.test(content)) {
        add(
          facts,
          fact(
            "ship",
            "The release tag is derived from the version in `Cargo.toml`.",
            path,
            4,
          ),
        );
      }
    }
    if (/CONTRIBUTING/i.test(path)) {
      add(
        facts,
        fact(
          "devloop",
          `Follow repository contribution guidance in \`${path}\`.`,
          path,
          4,
        ),
      );
    }
  }

  if (source.pullRequests.length) {
    const merged = source.pullRequests.filter((pr) => pr.merged).length;
    add(
      facts,
      fact(
        "process",
        `${merged}/${source.pullRequests.length} selected pull requests are merged; keep work mergeable before requesting review.`,
        "pull request metadata",
        2,
      ),
    );
    const labels = counts(source.pullRequests.flatMap((pr) => pr.labels))
      .slice(0, 12).map(([label, count]) => `\`${label}\` (${count})`);
    if (labels.length) {
      add(
        facts,
        fact(
          "labels",
          `Common pull request labels are ${labels.join(", ")}.`,
          "pull request labels",
          2,
        ),
      );
    }
    const described = source.pullRequests.filter((pr) =>
      pr.body.trim().length > 80
    ).length;
    if (described / source.pullRequests.length >= 0.7) {
      add(
        facts,
        fact(
          "title-body",
          "Most selected pull requests contain a substantive description; explain purpose, scope, and verification before requesting review.",
          "pull request descriptions",
          3,
        ),
      );
    }
    const reviewText = source.pullRequests.flatMap((
      pr,
    ) => [...pr.comments, ...pr.reviews]).join("\n").toLowerCase();
    for (
      const [term, instruction] of [
        ["test", "Include or update tests when behavior changes."],
        [
          "changelog",
          "Update the changelog when the repository process requires it.",
        ],
        ["documentation", "Update documentation when public behavior changes."],
        ["type", "Keep types and type-checking valid before review."],
      ]
    ) {
      const count =
        (reviewText.match(new RegExp(`\\b${term}\\w*\\b`, "g")) ?? []).length;
      if (count >= 2) {
        add(
          facts,
          fact(
            "review-bar",
            instruction,
            `review discussion (${count} mentions)`,
            count,
          ),
        );
      }
    }
    if (source.pullRequests.some((pr) => pr.additions + pr.deletions > 1000)) {
      add(
        facts,
        fact(
          "review-bar",
          "Keep large changes focused and explain their risk and verification in the pull request.",
          "pull request change sizes",
          2,
        ),
      );
    }
  }

  if (source.commits.length) {
    const conventional = source.commits.filter((commit) =>
      /^(feat|fix|docs|refactor|test|build|ci|chore|perf|style)(\(.+\))?!?:\s/i
        .test(
          String((commit.commit as Json | undefined)?.message ?? ""),
        )
    ).length;
    if (conventional / source.commits.length >= 0.6) {
      add(
        facts,
        fact(
          "style",
          "Use conventional commit prefixes when creating commits.",
          "commit history",
          3,
        ),
      );
    }
    const examples = source.commits.slice(0, 8).map((commit) =>
      String((commit.commit as Json | undefined)?.message ?? "").split("\n")[0]
    ).filter(Boolean);
    if (examples.length) {
      add(
        facts,
        fact(
          "style",
          `Recent commit examples: ${
            examples.map((message) =>
              `\`${message.slice(0, 100)}\``
            ).join("; ")
          }.`,
          "commit history",
          2,
        ),
      );
    }
  }

  if (
    options.includePullRequestChanges &&
    source.pullRequests.some((pr) => pr.changedFiles.length)
  ) {
    const files = counts(source.pullRequests.flatMap((pr) => pr.changedFiles))
      .slice(0, 10);
    add(
      facts,
      fact(
        "review-bar",
        `Frequently changed files include ${
          files.map(([path]) => `\`${path}\``).join(", ")
        }; check nearby tests and workflows before editing.`,
        "pull request files",
        2,
      ),
    );
  }
  return [...facts.values()];
}
