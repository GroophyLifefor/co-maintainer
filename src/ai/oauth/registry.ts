/** The OAuth providers `co-maintainer oauth` knows.
 *
 * One entry today, Sign in with ChatGPT. A future provider (say Claude under
 * a subscription) is a new id plus a new ops object here, with no change to
 * the command or to the experimental flag's plumbing. */
import type { AiProvider } from "../../types.ts";
import { CliError, EXIT_USAGE } from "../../cli/error.ts";
import { SIWC_ALIAS, SIWC_LABEL, SIWC_PROVIDER } from "./ids.ts";
import {
  SignInWithChatGptProvider,
  credentialsPath,
  listModels,
  login,
  logout,
  refresh,
  requireCredentials,
  type Credentials,
  type ModelInfo,
} from "./sign-in-with-chatgpt.ts";

export const OAUTH_PROVIDER_IDS = [SIWC_PROVIDER] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** The provider `--experimental-siwc` selects. Kept here so the flag's
 * plumbing never names a provider string directly. */
export const EXPERIMENTAL_OAUTH_PROVIDER: OAuthProviderId = SIWC_PROVIDER;

/** The plain alias for a given id, if it has one. */
export function oauthAlias(id: OAuthProviderId): string {
  return id === SIWC_PROVIDER ? SIWC_ALIAS : id;
}

/** `--provider` value to a known id, or undefined. Accepts the short alias. */
export function resolveOAuthProvider(
  value: string | undefined,
): OAuthProviderId | undefined {
  if (!value) return undefined;
  if (value === SIWC_PROVIDER || value === SIWC_ALIAS) return SIWC_PROVIDER;
  return undefined;
}

export function oauthUnknownProvider(value: string | undefined): CliError {
  return new CliError(
    "oauth_unknown_provider",
    `Unknown OAuth provider ${value ? `"${value}"` : ""}.`,
    `Pass --provider=${SIWC_PROVIDER} (or ${SIWC_ALIAS}).`,
    EXIT_USAGE,
  );
}

export type OAuthOps = {
  label: string;
  credentialsPath(): string;
  /** The browser flow; always starts a new sign-in. */
  login(): Promise<Credentials>;
  logout(): Promise<boolean>;
  refresh(): Promise<Credentials>;
  ping(): Promise<{ credentials: Credentials; models: ModelInfo[] }>;
  listModels(): Promise<ModelInfo[]>;
  createProvider(model: string): AiProvider;
};

const SIWC_OPS: OAuthOps = {
  label: SIWC_LABEL,
  credentialsPath,
  login,
  logout,
  refresh: async () => refresh(await requireCredentials()),
  ping: async () => {
    const credentials = await requireCredentials();
    return { credentials, models: await listModels(credentials) };
  },
  listModels: async () => listModels(await requireCredentials()),
  createProvider: (model) => new SignInWithChatGptProvider(model),
};

export function oauthOps(id: OAuthProviderId): OAuthOps {
  if (id === SIWC_PROVIDER) return SIWC_OPS;
  throw oauthUnknownProvider(id);
}
