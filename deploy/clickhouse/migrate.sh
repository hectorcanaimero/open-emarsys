#!/usr/bin/env bash
# Aplica deploy/clickhouse/migrations/*.sql en orden sobre la base `oe` y
# registra cada una en oe.schema_migrations. Idempotente: correrlo dos veces
# no reaplica una migración ya registrada (F0.2.T2).
set -euo pipefail

CH_HOST="${OE_CH_HOST:-localhost}"
CH_HTTP_PORT="${OE_CH_HTTP_PORT:-8123}"
CH_USER="${OE_CH_ADMIN_USER:-oe_admin}"
CH_PASSWORD="${OE_CH_ADMIN_PASSWORD:?OE_CH_ADMIN_PASSWORD is required}"
CH_DB="${OE_CH_DB:-oe}"
CH_URL="http://${CH_HOST}:${CH_HTTP_PORT}/"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${script_dir}/migrations"

ch_query() {
  curl -sS -f "${CH_URL}" --user "${CH_USER}:${CH_PASSWORD}" --data-binary "$1"
}

ch_query "CREATE DATABASE IF NOT EXISTS ${CH_DB}" >/dev/null

applied=""
if [ "$(ch_query "EXISTS TABLE ${CH_DB}.schema_migrations")" = "1" ]; then
  applied="$(ch_query "SELECT version FROM ${CH_DB}.schema_migrations FORMAT TSV")"
fi

shopt -s nullglob
for file in "${migrations_dir}"/*.sql; do
  version="$(basename "${file}" .sql)"
  if printf '%s\n' "${applied}" | grep -qx "${version}"; then
    echo "skip ${version} (ya aplicada)"
    continue
  fi
  echo "aplicando ${version}"
  ch_query "$(cat "${file}")" >/dev/null
  ch_query "INSERT INTO ${CH_DB}.schema_migrations (version) VALUES ('${version}')" >/dev/null
  applied="$(printf '%s\n%s' "${applied}" "${version}")"
done

echo "migraciones al día"
