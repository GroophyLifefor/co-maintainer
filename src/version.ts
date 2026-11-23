/** The single source of truth for the released version: `package.json`.
 * Reading it once here with an import attribute keeps the six call sites independent of the file layout. */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
