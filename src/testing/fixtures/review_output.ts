/** Reconstructed F02 answers (CORE-40).
 *
 * F02 was reported from a local review: one finding ended mid-token
 * (`... while \`u`), and the next began inside the previous one's prose
 * (`s it through the package's public entry point`). The cause was not the
 * screen: the model wrote the heading separator as `:` where the parser only
 * accepted `—`, so every heading was rejected and the parser fell back to a
 * fixed-width slice of the answer (`body.slice(at - 80, at + 200)`), which cut
 * at byte offsets instead of finding boundaries.
 *
 * These are the two answers the fix must survive: the old prose Markdown with
 * colon separators, and the JSON the model now returns instead. Both describe
 * the same two findings, so a test can assert they agree.
 */

/** The old shape, with the exact separator mistake that triggered F02. The
 * prose here is complete: the report's `... while \`u` and `s it through ...`
 * were not what the model wrote, they were where the old parser sliced this
 * answer once its headings were rejected. A correct parse returns both bodies
 * whole. */
export const F02_COLON_MARKDOWN = `## Findings

### [P2 · non-blocking] \`src/local/review.ts\`: \`waitFor()\`
Location: \`src/local/review.ts:120-118\`

The helper polls a condition in a loop while \`until\` is undefined and never observes the deadline, so a condition that stays false spins until the caller is killed.

### [P2 · non-blocking] \`src/pr/post.ts\`: \`postReview()\`
Location: \`src/pr/post.ts:44-52\`

When the response is empty this passes it through the package's public entry point and returns without posting. The caller treats that as success.
`;

/** The same two findings as structured output, which is what the review asks
 * for now. Rendering this produces one well-formed block per finding. */
export const F02_JSON = JSON.stringify({
  findings: [
    {
      severity: "P2",
      blocking: false,
      path: "src/local/review.ts",
      lineFrom: 120,
      lineTo: 118,
      symbol: "waitFor()",
      title: "The poll loop never exits when the condition stays false",
      body: "The loop re-reads the condition but has no deadline, so a condition that never becomes true spins forever. The caller assumes it returns.",
    },
    {
      severity: "P2",
      blocking: false,
      path: "src/pr/post.ts",
      lineFrom: 44,
      lineTo: 52,
      symbol: "postReview()",
      title: "An empty response is passed through as if it were posted",
      body: "When the response is empty this passes it through the package's public entry point and returns without posting. The caller treats that as success.",
    },
  ],
});

/** The two findings a correct parse must recover, in order: the paths they
 * point at. Used to compare the JSON render with the legacy parser. */
export const F02_EXPECTED_PATHS = ["src/local/review.ts", "src/pr/post.ts"];
