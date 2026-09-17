import {
  patchFromNewFileContent,
  patchFromSymlinkTarget,
} from "./git_untracked.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("patchFromNewFileContent: empty file", () => {
  const r = patchFromNewFileContent(enc(""));
  if (r.binary || r.additions !== 0 || r.patch !== "") {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("patchFromNewFileContent: two lines with trailing newline", () => {
  const r = patchFromNewFileContent(enc("a\nb\n"));
  if (r.binary || r.additions !== 2) throw new Error(JSON.stringify(r));
  if (!r.patch.includes("@@ -0,0 +1,2 @@")) throw new Error(r.patch);
  if (!r.patch.includes("+a\n+b\n")) throw new Error(r.patch);
});

Deno.test("patchFromNewFileContent: no trailing newline", () => {
  const r = patchFromNewFileContent(enc("only"));
  if (r.additions !== 1) throw new Error(JSON.stringify(r));
  if (!r.patch.includes("\\ No newline at end of file")) {
    throw new Error(r.patch);
  }
});

Deno.test("patchFromNewFileContent: NUL in first bytes is binary", () => {
  const bytes = new Uint8Array([0x61, 0x00, 0x62]);
  const r = patchFromNewFileContent(bytes);
  if (!r.binary || r.patch !== "" || r.additions !== 0) {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("patchFromSymlinkTarget", () => {
  const r = patchFromSymlinkTarget("../target");
  if (r.additions !== 1 || !r.patch.includes("+../target")) {
    throw new Error(JSON.stringify(r));
  }
});
