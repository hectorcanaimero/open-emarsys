#!/bin/sh
# Job de inicio: crea el namespace open-emarsys si todavía no existe.
# Idempotente para que `docker compose up` se pueda repetir sin error.
set -eu

if temporal --address "${TEMPORAL_ADDRESS}" operator namespace describe open-emarsys >/dev/null 2>&1; then
  echo "namespace open-emarsys ya existe"
else
  temporal --address "${TEMPORAL_ADDRESS}" operator namespace create open-emarsys --retention 72h
fi
