/** The review `extension debug-run` runs an extension against: pull request 45
 * of GroophyLifefor/heap-analysis, with its context, diff and a finished AI
 * review. All of it is written here, so a debug run needs no AI, no network
 * and no GitHub access. */
import type { ExtensionDetails } from "./run_folder.ts";

export const MOCK_DETAILS: Omit<
  ExtensionDetails,
  "reviewResultPath" | "diffPath"
> = {
  schemaVersion: 1,
  reviewType: "pr",
  repo: "GroophyLifefor/heap-analysis",
  prNumber: 45,
  branch: null,
  workdir: "",
  headSha: "4f1c2d9a7b3e5f60718293a4b5c6d7e8f9012345",
  baseSha: "9a8b7c6d5e4f30211203f4e5d6c7b8a990817263",
  scope: "whole-pr",
  sinceCommit: null,
  trigger: "debug-run",
  round: 1,
};

export const MOCK_DIFF = `diff --git a/src/snapshot/toolbar.tsx b/src/snapshot/toolbar.tsx
--- a/src/snapshot/toolbar.tsx
+++ b/src/snapshot/toolbar.tsx
@@ -12,9 +12,14 @@ export function Toolbar({ onSnapshot, busy }: ToolbarProps) {
   return (
     <div className="toolbar">
-      <button onClick={onSnapshot} disabled={busy}>
-        Take snapshot
-      </button>
+      {busy ? (
+        <span className="toolbar-status">Taking snapshot...</span>
+      ) : (
+        <button onClick={onSnapshot} aria-label="Take snapshot">
+          Take snapshot
+        </button>
+      )}
       <ExportMenu />
     </div>
   );
 }
diff --git a/src/heap/parse.ts b/src/heap/parse.ts
--- a/src/heap/parse.ts
+++ b/src/heap/parse.ts
@@ -40,6 +40,10 @@ export function parseNodes(raw: Uint32Array, fields: number): HeapNode[] {
   const nodes: HeapNode[] = [];
   for (let offset = 0; offset < raw.length; offset += fields) {
+    if (offset + fields > raw.length) {
+      break;
+    }
     nodes.push(readNode(raw, offset));
   }
   return nodes;
 }
`;

export const MOCK_REVIEW_RESULT = {
  schemaVersion: 1,
  summary: { new: 1, open: 0, closed: 0, blocking: 0 },
  findings: [
    {
      id: "8d6c1f4e-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
      state: "new",
      closeReason: null,
      severity: "P3",
      blocking: false,
      path: "src/heap/parse.ts",
      lineFrom: 42,
      lineTo: 44,
      title: "[P3 · non-blocking] `src/heap/parse.ts`: `parseNodes`",
      body: "A truncated snapshot now stops quietly. Logging how many trailing values were dropped would make a corrupt file easier to spot.",
      suggestion: null,
    },
  ],
};
