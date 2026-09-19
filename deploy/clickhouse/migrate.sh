#!/usr/bin/env bash
# Aplica deploy/clickhouse/migrations/*.sql en orden sobre la base `oe` y
# registra cada una en oe.schema_migrations. Idempotente: correrlo dos veces
# no reaplica una migración ya registrada (F0.2.T2).
#
# Habla el protocolo nativo (el mismo que los servicios, clickhouse-go), así que
# basta con publicar el puerto nativo del servidor. Usa clickhouse-client si está
# instalado; si no, el de la imagen de ClickHouse del compose.
set -euo pipefail

CH_HOST="${OE_CH_HOST:-localhost}"
CH_NATIVE_PORT="${OE_CH_NATIVE_PORT:-9004}"
CH_USER="${OE_CH_ADMIN_USER:-oe_admin}"
CH_PASSWORD="${OE_CH_ADMIN_PASSWORD:?OE_CH_ADMIN_PASSWORD is required}"
CH_DB="${OE_CH_DB:-oe}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${script_dir}/migrations"

if command -v clickhouse-client >/dev/null; then
  client=(clickhouse-client)
else
  client=(docker run --rm -i --network host clickhouse/clickhouse-server:25.3 clickhouse-client)
fi

# La consulta va por stdin: --multiquery admite migraciones con varias sentencias.
ch_query() {
  printf '%s' "$1" | "${client[@]}" --host "${CH_HOST}" --port "${CH_NATIVE_PORT}" \
    --user "${CH_USER}" --password "${CH_PASSWORD}" --multiquery
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
