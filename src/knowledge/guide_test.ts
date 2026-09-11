import { buildReviewDocuments } from "./guide.ts";
import { testFact } from "../testing/helpers.ts";

Deno.test("review guides are optional and avoid duplicate detailed content", () => {
  const facts = [
    testFact(
      "Include tests for behavior changes.",
      "current",
      "review discussion (4 mentions)",
    ),
    testFact("Keep the pull request focused.", "historical-example", "PR #2"),
    testFact(
      "Document public behavior changes.",
      "historical-example",
      "PR #3",
    ),
  ].map((item) => ({ ...item, sectionKey: "review-bar" }));
  const documents = buildReviewDocuments(facts);
  if (!documents?.guide.includes("PR review guide")) {
    throw new Error("review guide was not created for repeated requests");
  }
  if (documents.detailed) {
    throw new Error("small review guide unexpectedly created detailed output");
  }
  if (buildReviewDocuments(facts.slice(0, 2))) {
    throw new Error("review guide was created below the request threshold");
  }
  const manyFacts = Array.from(
    { length: 60 },
    (_, index) =>
      testFact(
        `Request ${index}: verify the affected behavior.`,
        "historical-example",
        `PR #${index + 1}`,
      ),
  ).map((item) => ({ ...item, sectionKey: "review-bar" }));
  const largeDocuments = buildReviewDocuments(manyFacts);
  if (!largeDocuments?.detailed) {
    throw new Error("detailed review guide was not created for large output");
  }
  if (largeDocuments.detailed.split("\n").length > 500) {
    throw new Error("detailed review guide exceeded 500 lines");
  }
  if (!largeDocuments.guide.includes("PR_REVIEW_DETAILED_GUIDE.md")) {
    throw new Error("short review guide did not reference detailed output");
  }
});
