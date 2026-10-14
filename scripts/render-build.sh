#!/usr/bin/env bash
# Render build for one app: installs dependencies with the repository's pnpm, then builds it.
# Usage: bash scripts/render-build.sh api|owner-web|admin-web|pos
set -euo pipefail

app="${1:?Name the app to build: api, owner-web, admin-web, or pos}"

# Check the settings first, so a missing one fails in seconds rather than after the install.
case "$app" in
  api)
    : "${DATABASE_URL:?Set DATABASE_URL to the Neon connection string}"
    : "${SEED_ADMIN_CREDENTIAL:?Set SEED_ADMIN_CREDENTIAL, or the demo admin gets the public default password}"
    : "${SEED_OWNER_CREDENTIAL:?Set SEED_OWNER_CREDENTIAL, or the demo owner gets the public default password}"
    ;;
  owner-web|admin-web|pos)
    case "${VITE_API_URL:-}" in
      https://*) ;;
      *) echo "Set VITE_API_URL to the API address starting with https://, such as https://pharmica-api.onrender.com (it is \"${VITE_API_URL:-}\")" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unknown app \"$app\": use api, owner-web, admin-web, or pos" >&2
    exit 1
    ;;
esac

# Use the pnpm version pinned in package.json (through Corepack) when pnpm is not already installed.
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  corepack enable --install-directory "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

pnpm install --frozen-lockfile

case "$app" in
  api)
    pnpm --filter @pharmica/database db:generate
    pnpm --filter @pharmica/api build
    # The free plan has no pre-deploy step, so the database is brought up to date here, before the new API starts.
    pnpm --filter @pharmica/database db:migrate:deploy
    pnpm --filter @pharmica/database db:seed
    ;;
  *)
    pnpm --filter "@pharmica/$app" build
    ;;
esac
