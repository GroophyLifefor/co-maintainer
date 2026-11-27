/** The public keys this build trusts for licenses.
 *
 * Empty until the real public keys are added: the private key is held by one
 * person, offline, and a key is never made up here. With no key, every
 * license file is refused as an unknown key and the product runs as free.
 * Tests use their own keys and never put one in this list. */
import type { PublicKeys } from "./format.ts";

export const LICENSE_KEYS: PublicKeys = {};
