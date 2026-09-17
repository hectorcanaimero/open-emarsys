#!/bin/bash
# Ejecutado por el entrypoint oficial de ClickHouse (docker-entrypoint-initdb.d)
# tras arrancar el servidor. Crea un rol lector y uno escritor sobre la base
# `oe` y un usuario por servicio (NFR-2), igual que deploy/postgres/init/00-roles.sql.
set -euo pipefail

ch() {
  clickhouse-client --user "${CLICKHOUSE_USER}" --password "${CLICKHOUSE_PASSWORD}" --multiquery --query "$1"
}

ch "CREATE ROLE IF NOT EXISTS oe_reader"
ch "GRANT SELECT ON ${CLICKHOUSE_DB}.* TO oe_reader"

ch "CREATE ROLE IF NOT EXISTS oe_writer"
ch "GRANT SELECT, INSERT ON ${CLICKHOUSE_DB}.* TO oe_writer"

create_user() {
  local user="$1" password="$2" role="$3"
  ch "CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH sha256_password BY '${password}'"
  ch "GRANT ${role} TO ${user}"
  ch "ALTER USER ${user} DEFAULT ROLE ${role}"
}

# Escritores: solo collector/cmd/sink escribe eventos crudos; segments, ml y
# analytics escriben sus propias tablas derivadas (segment_members,
# contact_scores, attributed_revenue) y también necesitan leer el resto.
create_user collector  "${OE_CH_COLLECTOR_PASSWORD}"  oe_writer
create_user segments   "${OE_CH_SEGMENTS_PASSWORD}"   oe_writer
create_user ml         "${OE_CH_ML_PASSWORD}"         oe_writer
create_user analytics  "${OE_CH_ANALYTICS_PASSWORD}"  oe_writer

# Lectores: core (timeline), importer (export) y automation (stats por nodo).
create_user core       "${OE_CH_CORE_PASSWORD}"       oe_reader
create_user importer   "${OE_CH_IMPORTER_PASSWORD}"   oe_reader
create_user automation "${OE_CH_AUTOMATION_PASSWORD}" oe_reader
