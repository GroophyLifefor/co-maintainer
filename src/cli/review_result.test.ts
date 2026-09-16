import {
  isBlockingFinding,
  reviewExitCodeFromResolved,
  sortResolvedFindings,
} from "./review_result.ts";
import type { ResolvedFinding } from "../review/carry_over.ts";

function row(
  partial: Partial<ResolvedFinding> & Pick<ResolvedFinding, "state" | "title">,
): ResolvedFinding {
  return {
    id: "id",
    path: "a.ts",
    lineFrom: 1,
    lineTo: 1,
    bodyMd: "",
    anchorText: null,
    severity: "P2",
    carriedFromId: null,
    firstSeenReviewId: null,
    ...partial,
  };
}

Deno.test("isBlockingFinding: non-blocking title is not blocking", () => {
  if (isBlockingFinding("[P2 · non-blocking] `a.ts` — `x`", "P2")) {
    throw new Error("expected false");
  }
});

Deno.test("isBlockingFinding: blocking title", () => {
  if (!isBlockingFinding("[P1 · blocking] `a.ts` — `x`", "P1")) {
    throw new Error("expected true");
  }
});

Deno.test("reviewExitCodeFromResolved uses open/new blocking only", () => {
  const findings = [
    row({ state: "closed", title: "[P1 · blocking] x" }),
    row({ state: "open", title: "[P2 · non-blocking] x" }),
  ];
  if (reviewExitCodeFromResolved(findings) !== 0) throw new Error("exit 0");
  findings.push(row({ state: "new", title: "[P1 · blocking] y" }));
  if (reviewExitCodeFromResolved(findings) !== 1) throw new Error("exit 1");
});

Deno.test("sortResolvedFindings: new before open before closed", () => {
  const sorted = sortResolvedFindings([
    row({ state: "closed", title: "c" }),
    row({ state: "new", title: "n" }),
    row({ state: "open", title: "o" }),
  ]);
  if (sorted.map((f) => f.state).join(",") !== "new,open,closed") {
    throw new Error(sorted.map((f) => f.state).join(","));
  }
});
