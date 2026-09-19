#!/usr/bin/env bash
# Single entry point of `make seed`: runs scripts/seed/*/seed.{ts,sh} in directory-name order
# (each phase adds its own NN-name/ directory). Every seed must be idempotent.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD

set -a
[ -f deploy/compose/.env ] && . deploy/compose/.env
[ -f .env.local ] && . .env.local
set +a

# Seeds run on the host (core's CLI through tsx), so on a clean clone they need the
# workspace installed, core's workspace deps built and its Prisma client generated first.
pnpm install --frozen-lockfile --silent
pnpm --filter "@oe/core^..." run build >/dev/null # workspace libs resolve to their dist/
pnpm --filter @oe/core run generate >/dev/null

shopt -s nullglob
for seed in scripts/seed/*/seed.*; do
  echo "==> $seed"
  case "$seed" in
    *.ts) pnpm --filter @oe/core exec tsx "$ROOT/$seed" ;; # tsx is a dependency of @oe/core
    *.sh) bash "$seed" ;;
    *) echo "unsupported seed type: $seed" >&2; exit 1 ;;
  esac
done
