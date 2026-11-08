#!/usr/bin/env bash
# The body of the co-maintainer GitHub Action.
#
# It lives in a script and not in action.yml so that `scripts/action_run.test.ts`
# can run it. The action passes every input as an environment variable, never by
# pasting it into this script, so an input can not become shell code.
#
#   REMOTE_HOST   remote-host input
#   REMOTE_TOKEN  remote-token input
#   REMOTE_BYOK   remote-byok input, may be empty
#   TO_BRANCH     to-branch input, may be empty
#   VERSION       version input, may be empty
#   HEAD_REF      github.head_ref, empty outside a pull request
#   ACTION_PATH   github.action_path
#
# For tests only: CM_ACTION_PACKAGE replaces `co-maintainer@<version>`, and
# CM_ACTION_DRY_RUN prints the command instead of running it.
set -euo pipefail

fail() {
  local code="$1" message="$2"
  echo "::error title=co-maintainer::${message}"
  echo "${message}" >&2
  exit "${code}"
}

SECRETS_NOTE="Pull requests from forks do not receive repository secrets, so this step cannot run for them."
REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_TOKEN="${REMOTE_TOKEN:-}"
REMOTE_BYOK="${REMOTE_BYOK:-}"
TO_BRANCH="${TO_BRANCH:-}"
VERSION="${VERSION:-}"
HEAD_REF="${HEAD_REF:-}"
ACTION_PATH="${ACTION_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -z "${REMOTE_HOST}" ]; then
  fail 2 "remote-host is empty. ${SECRETS_NOTE}"
fi
if [ -z "${REMOTE_TOKEN}" ]; then
  fail 2 "remote-token is empty. ${SECRETS_NOTE}"
fi

# `::add-mask::` reads one line, so a value with a line break would leak the
# rest into the log. A real token never has one.
for name in REMOTE_TOKEN REMOTE_BYOK; do
  case "${!name}" in
    *$'\n'* | *$'\r'*) fail 2 "${name//_/-} must be a single line." ;;
  esac
done
echo "::add-mask::${REMOTE_TOKEN}"
if [ -n "${REMOTE_BYOK}" ]; then
  echo "::add-mask::${REMOTE_BYOK}"
fi

if [ -z "${VERSION}" ]; then
  VERSION="$(node -p "require(process.argv[1]).version" "${ACTION_PATH}/package.json")"
fi
if ! [[ "${VERSION}" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
  fail 2 "version \"${VERSION}\" is not a valid npm version or tag."
fi
PACKAGE="${CM_ACTION_PACKAGE:-co-maintainer@${VERSION}}"

if [ -n "${TO_BRANCH}" ]; then
  if [[ "${TO_BRANCH}" == -* ]]; then
    fail 2 "to-branch \"${TO_BRANCH}\" is not a branch name."
  fi
  if [ -z "${CM_ACTION_DRY_RUN:-}" ]; then
    # A checkout can be shallow or hold only the pull request, so the base
    # branch is fetched first. `review` needs `origin/<to-branch>` to diff
    # against.
    if ! git fetch --no-tags origin "+refs/heads/${TO_BRANCH}:refs/remotes/origin/${TO_BRANCH}"; then
      fail 3 "Could not fetch the base branch ${TO_BRANCH} from origin."
    fi
  fi
fi

ARGS=(review --remote --output=github)
if [ -n "${TO_BRANCH}" ]; then
  ARGS+=("--to-branch=${TO_BRANCH}")
fi
if [ -n "${HEAD_REF}" ]; then
  ARGS+=("--branch=${HEAD_REF}")
fi
if [ -n "${REMOTE_BYOK}" ]; then
  ARGS+=(--remote-byok)
fi

# Install the reviewer OUTSIDE the checkout. The pull request controls every
# file in the workspace, so running `npx`/`npm` there let a committed `.npmrc`
# redirect the registry, an install script run with the secrets in scope, or a
# committed `node_modules` be picked up in place of the real package.
CM_RUN_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/co-maintainer-run"
CM_ENTRY="${CM_RUN_DIR}/node_modules/co-maintainer/dist/main.js"

if [ -n "${CM_ACTION_DRY_RUN:-}" ]; then
  echo "install ${PACKAGE} into ${CM_RUN_DIR}"
  echo "run node ${CM_ENTRY} ${ARGS[*]}"
  exit 0
fi

# The host and the keys go by environment, so they never show in the process
# list. The token is already masked in the log above.
export CM_REMOTE_HOST="${REMOTE_HOST}"
export CM_REMOTE_TOKEN="${REMOTE_TOKEN}"
if [ -n "${REMOTE_BYOK}" ]; then
  export CM_REMOTE_BYOK="${REMOTE_BYOK}"
fi

# Install into a throwaway dir with a neutral npm config and no lifecycle
# scripts, then run the installed entry point with `node` directly (no npx, no
# `.cmd` shim). The pull request's files are only ever read as review data.
rm -rf "${CM_RUN_DIR}"
mkdir -p "${CM_RUN_DIR}"
: > "${CM_RUN_DIR}/.npmrc"
if ! ( cd "${CM_RUN_DIR}" \
  && npm install --prefix "${CM_RUN_DIR}" --no-save --no-audit --no-fund \
       --ignore-scripts --userconfig "${CM_RUN_DIR}/.npmrc" "${PACKAGE}" ); then
  fail 4 "Could not install ${PACKAGE}."
fi
node "${CM_ENTRY}" "${ARGS[@]}"
