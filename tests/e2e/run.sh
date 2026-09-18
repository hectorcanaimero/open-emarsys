#!/usr/bin/env bash
# Single entry point of `make e2e`: runs every suite in tests/e2e/*/ against the running
# platform (`make up && make seed`). Each phase adds its own directory.
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a
[ -f deploy/compose/.env ] && . deploy/compose/.env
[ -f .env.local ] && . .env.local
set +a

cd tests/e2e
# Browser binaries are not part of the npm package.
pnpm exec playwright install chromium
shopt -s nullglob
suites=(*/)
[ ${#suites[@]} -gt 0 ] || { echo "no e2e suites in tests/e2e/*/" >&2; exit 1; }
pnpm exec playwright test "${suites[@]}" "$@"
