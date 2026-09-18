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

shopt -s nullglob
for seed in scripts/seed/*/seed.*; do
  echo "==> $seed"
  case "$seed" in
    *.ts) pnpm --filter @oe/core exec tsx "$ROOT/$seed" ;; # tsx is a dependency of @oe/core
    *.sh) bash "$seed" ;;
    *) echo "unsupported seed type: $seed" >&2; exit 1 ;;
  esac
done
