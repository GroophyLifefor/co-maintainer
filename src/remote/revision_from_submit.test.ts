import { revisionFromSubmitJson } from "./revision_from_submit.ts";

Deno.test("revisionFromSubmitJson rejects invalid file status", () => {
  let err = "";
  try {
    revisionFromSubmitJson({
      files: [{
        path: "a.ts",
        previousPath: null,
        status: "not-a-status",
        binary: false,
        additions: 1,
        deletions: 0,
        patch: "x",
      }],
    });
  } catch (error) {
    err = String(error);
  }
  if (!err.includes("status")) {
    throw new Error(`expected status error, got ${err}`);
  }
});
