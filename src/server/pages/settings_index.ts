/** Every setting the settings search can find: its name, a few words on what
 * it does, and the field it jumps to. The search box above the Settings menu
 * reads this list from the page, so it works without a request. */

export type SettingEntry = {
  /** The field's label on its page. */
  name: string;
  description: string;
  /** The settings page, as its menu names it. */
  page: string;
  /** The page and the element id the search jumps to. */
  href: string;
};

function entry(
  page: string,
  path: string,
  id: string,
  name: string,
  description: string,
): SettingEntry {
  return { name, description, page, href: `${path}#${id}` };
}

const AI = "/settings/ai";
const GITHUB = "/settings/github";
const DEFAULTS = "/settings/defaults";
const REMOTE = "/settings/remote";
const SERVER = "/settings/server";
const SIGN_IN = "/settings/sign-in";
const DANGER = "/settings/danger";
const EXTENSIONS = "/settings/extensions";
const AUDIT = "/settings/audit";

export const SETTINGS_INDEX: SettingEntry[] = [
  entry(
    "AI models",
    AI,
    "ai-provider",
    "Provider",
    "Which AI service writes the reviews.",
  ),
  entry(
    "AI models",
    AI,
    "token",
    "API key",
    "The key the reviews are paid with.",
  ),
  entry(
    "AI models",
    AI,
    "high",
    "Review model",
    "The model that writes each review.",
  ),
  entry(
    "AI models",
    AI,
    "low",
    "Extraction model",
    "The cheaper model that reads past reviews and builds knowledge.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "auth",
    "Access",
    "How the server signs in to GitHub, a token or the GitHub App.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "pat",
    "Personal access token",
    "The GitHub token used when the App is not set up.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "app-id",
    "App ID",
    "The GitHub App that posts reviews.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "webhook-url",
    "Webhook address",
    "Where GitHub sends pull request events.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "app-key",
    "Private key",
    "The GitHub App private key.",
  ),
  entry(
    "GitHub",
    GITHUB,
    "hook-secret",
    "Webhook secret",
    "The secret GitHub signs each event with.",
  ),
  entry(
    "Review defaults",
    DEFAULTS,
    "def-months",
    "Months of pull requests",
    "How far back a new repository reads past reviews.",
  ),
  entry(
    "Review defaults",
    DEFAULTS,
    "def-commits",
    "Commits",
    "How many commits a new repository reads.",
  ),
  entry(
    "Review defaults",
    DEFAULTS,
    "def-lines",
    "Max lines per pull request",
    "Pull requests larger than this are left out of the knowledge.",
  ),
  entry(
    "Review defaults",
    DEFAULTS,
    "def-policy",
    "Who gets a review",
    "Which pull requests a new repository reviews.",
  ),
  entry(
    "Remote access",
    REMOTE,
    "remote-token-name",
    "Remote review tokens",
    "Tokens the CLI uses to run reviews on this server.",
  ),
  entry(
    "Remote access",
    REMOTE,
    "remote-byok-policy",
    "Client key policy",
    "Whether a CLI client may bring its own AI key.",
  ),
  entry(
    "Server",
    SERVER,
    "max-jobs",
    "Max concurrent jobs",
    "How many reviews and syncs run at the same time.",
  ),
  entry(
    "Server",
    SERVER,
    "remote-timeout",
    "Remote sync timeout",
    "How long a remote review may wait for its files.",
  ),
  entry(
    "Server",
    SERVER,
    "remote-per-token",
    "Max remote reviews per token",
    "A limit per CLI token.",
  ),
  entry(
    "Server",
    SERVER,
    "remote-tool-chars",
    "Max tool output chars",
    "How much text one tool call may return in a remote review.",
  ),
  entry(
    "Sign-in",
    SIGN_IN,
    "password-auth",
    "Password sign-in",
    "Sign in to the dashboard with a password.",
  ),
  entry(
    "Sign-in",
    SIGN_IN,
    "github-auth",
    "GitHub sign-in",
    "Sign in to the dashboard with a GitHub account.",
  ),
  entry(
    "Sign-in",
    SIGN_IN,
    "oauth-client-id",
    "OAuth client ID",
    "The GitHub OAuth app used for sign-in.",
  ),
  entry(
    "Sign-in",
    SIGN_IN,
    "oauth-allowed-user",
    "Allowed GitHub username",
    "The one GitHub account that may sign in.",
  ),
  entry(
    "Sign-in",
    SIGN_IN,
    "pw-current",
    "Password",
    "Change the dashboard password.",
  ),
  entry(
    "Server",
    SERVER,
    "updates",
    "Updates",
    "The version this server runs, a newer release and how to update.",
  ),
  entry(
    "Audit log",
    AUDIT,
    "audit",
    "Audit log",
    "Who changed settings, tokens and repositories, who signed in, and when.",
  ),
  entry(
    "Review defaults",
    DEFAULTS,
    "def-blocking",
    "Blocking rule",
    "Which findings block a pull request, for every repository without its own rule.",
  ),
  entry(
    "Extensions",
    EXTENSIONS,
    "extensions",
    "Extensions",
    "Register, enable, disable and remove the commands that run around every review.",
  ),
  entry(
    "Danger zone",
    DANGER,
    "clear-all",
    "Clear all knowledge",
    "Delete the knowledge of every repository.",
  ),
];
