/** The OAuth provider ids and labels, in a leaf module.
 *
 * `registry.ts` and `sign-in-with-chatgpt.ts` both need these strings, and
 * `sign-in-with-chatgpt.ts` reaches `openai.ts` which reaches `provider.ts`
 * which reaches `registry.ts`. Keeping the constants here, with no imports,
 * lets both sides read them without a cycle that leaves them undefined. */
export const SIWC_PROVIDER = "sign-in-with-chatgpt";
export const SIWC_LABEL = "Sign in with ChatGPT";
/** The alias users may type instead of the full provider id. */
export const SIWC_ALIAS = "siwc";
