/** The single source of truth for the released version: `package.json`.
 * Import attributes work identically under Node 24 and Deno 2, and reading
 * it once here keeps the six call sites independent of the file layout. */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
