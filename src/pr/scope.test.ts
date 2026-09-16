import { computeScope, scopeInClone } from "./scope.ts";
import type { CommandResult, Run } from "./checkout.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

const ok = (stdout = "", code = 0): CommandResult => ({
  code,
  stdout,
  stderr: "",
});
const fail = (stderr = "boom"): CommandResult => ({
  code: 1,
  stdout: "",
  stderr,
});

/** A `git` fake for scopeInClone's happy path: two of the author's own
 * commits, one merge whose `--cc` combined diff shows a real conflict
 * resolution, out of a round diff that also carries an upstream file the
 * author never touched. */
function happyPathRun(): Run {
  return ((_command: string, args: string[]) => {
    const [sub] = args;
    if (sub === "rev-parse") {
      const rev = args[args.length - 1];
      if (rev === "base") return Promise.resolve(ok("base-sha"));
      if (rev === "head") return Promise.resolve(ok("head-sha"));
      return Promise.resolve(fail("unknown revision"));
    }
    if (sub === "cat-file") {
      const sha = args[args.length - 1];
      if (sha === "base-sha" || sha === "head-sha") {
        return Promise.resolve(ok("commit"));
      }
      return Promise.resolve(fail());
    }
    if (sub === "symbolic-ref") {
      return Promise.resolve(ok("refs/remotes/origin/main"));
    }
    if (sub === "merge-base") return Promise.resolve(ok("boundary-sha"));
    if (sub === "rev-list" && args.includes("--no-merges")) {
      return Promise.resolve(ok("own1\nown2"));
    }
    if (sub === "rev-list" && args.includes("--merges")) {
      return Promise.resolve(ok("merge1"));
    }
    if (sub === "diff" && args[1] === "--name-only") {
      return Promise.resolve(ok("a.ts\nb.ts\nc.ts\nd.ts"));
    }
    if (sub === "show") {
      const sha = args[args.length - 1];
      if (sha === "own1") return Promise.resolve(ok("a.ts"));
      if (sha === "own2") return Promise.resolve(ok("b.ts"));
      return Promise.resolve(ok(""));
    }
    if (sub === "diff-tree") {
      const sha = args[args.length - 1];
      if (sha === "merge1") return Promise.resolve(ok("c.ts"));
      return Promise.resolve(ok(""));
    }
    return Promise.resolve(fail(`unexpected git ${args.join(" ")}`));
  }) as Run;
}

Deno.test("scopeInClone separates own work from upstream, merge resolution included", async () => {
  const scope = await scopeInClone("clone", "base", "head", happyPathRun());
  if (!scope) throw new Error("expected a scope result");
  same(sorted(scope.ownFiles), ["a.ts", "b.ts", "c.ts"], "own files");
  same(sorted(scope.upstreamFiles), ["d.ts"], "upstream files");
  same(scope.ownCommits, 2, "own commit count");
  same(scope.mergeCommits, 1, "merge commit count");
  same(scope.defaultBranch, "refs/remotes/origin/main", "default branch");
});

Deno.test("a clean merge (no conflict) contributes no files", async () => {
  const run = happyPathRun();
  const cleanRun: Run = (command, args, cwd) => {
    if (args[0] === "diff-tree") return Promise.resolve(ok(""));
    return run(command, args, cwd);
  };
  const scope = await scopeInClone("clone", "base", "head", cleanRun);
  if (!scope) throw new Error("expected a scope result");
  same(sorted(scope.ownFiles), ["a.ts", "b.ts"], "no resolution files added");
  same(
    sorted(scope.upstreamFiles),
    ["c.ts", "d.ts"],
    "merge file stays upstream",
  );
});

Deno.test("falls back to probing main/master when origin/HEAD is unset", async () => {
  const run = happyPathRun();
  let sawMainProbe = false;
  const noSymref: Run = (command, args, cwd) => {
    if (args[0] === "symbolic-ref") return Promise.resolve(fail());
    if (
      args[0] === "rev-parse" &&
      args[args.length - 1] === "refs/remotes/origin/main"
    ) {
      sawMainProbe = true;
      return Promise.resolve(ok("main-sha"));
    }
    return run(command, args, cwd);
  };
  const scope = await scopeInClone("clone", "base", "head", noSymref);
  if (!scope) throw new Error("expected a scope result");
  same(sawMainProbe, true, "probed refs/remotes/origin/main");
  same(scope.defaultBranch, "refs/remotes/origin/main", "resolved default");
});

Deno.test("returns undefined when no default branch can be found", async () => {
  const run = happyPathRun();
  const noDefault: Run = (command, args, cwd) => {
    if (args[0] === "symbolic-ref") return Promise.resolve(fail());
    if (
      args[0] === "rev-parse" &&
      String(args[args.length - 1]).startsWith("refs/remotes/origin/")
    ) return Promise.resolve(fail());
    return run(command, args, cwd);
  };
  const scope = await scopeInClone("clone", "base", "head", noDefault);
  same(scope, undefined, "no default branch means no scope");
});

Deno.test("returns undefined when a commit cannot be resolved or fetched", async () => {
  const run: Run = (_command, args) => {
    if (args[0] === "rev-parse") return Promise.resolve(fail());
    if (args[0] === "fetch") return Promise.resolve(fail("not found"));
    return Promise.resolve(fail("unexpected"));
  };
  const scope = await scopeInClone("clone", "dangling-sha", "head", run);
  same(scope, undefined, "an unfetchable commit means no scope");
});

Deno.test("returns undefined when git rev-list fails outright", async () => {
  const run = happyPathRun();
  const brokenRevList: Run = (command, args, cwd) => {
    if (args[0] === "rev-list") return Promise.resolve(fail());
    return run(command, args, cwd);
  };
  const scope = await scopeInClone("clone", "base", "head", brokenRevList);
  same(scope, undefined, "a git failure means no scope, not a thrown error");
});

Deno.test("computeScope returns undefined when the clone itself cannot be made, without throwing", async () => {
  const run: Run = (_command, args) => {
    if (args[0] === "clone") {
      return Promise.resolve(fail("network unreachable"));
    }
    return Promise.resolve(fail());
  };
  const scope = await computeScope("owner/repo", "base", "head", {
    run,
  });
  same(scope, undefined, "a failed clone falls back to unscoped, not a crash");
});
