import { platformWarning } from "./serve.ts";

Deno.test("platformWarning is silent on linux and speaks up everywhere else", () => {
  if (platformWarning("linux") !== undefined) {
    throw new Error("linux should have no warning");
  }
  for (const os of ["windows", "darwin"] as const) {
    const warning = platformWarning(os);
    if (!warning?.includes(os)) {
      throw new Error(`expected a warning naming ${os}, got ${warning}`);
    }
  }
});
