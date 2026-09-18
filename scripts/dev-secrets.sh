#!/usr/bin/env bash
# Dev-only secrets so `make up` works on a clean clone (never use these in production): an
# RS256 key for core's JWTs, a service-credentials file and an encryption key, under the
# gitignored deploy/compose/.secrets/. Idempotent, and it only replaces the placeholders
# .env.example ships with, so values you set yourself in deploy/compose/.env are kept.
set -euo pipefail
cd "$(dirname "$0")/.."

env_file=deploy/compose/.env
dir="$PWD/deploy/compose/.secrets"
mkdir -p "$dir/jwt"

# core's container runs as uid 1001, so the mounted files must be world-readable.
[ -f "$dir/jwt/k1.pem" ] || openssl genrsa -out "$dir/jwt/k1.pem" 2048 2>/dev/null
[ -f "$dir/service-credentials.json" ] ||
  printf '{"segments":{"secret":"%s","scopes":["contacts:view"]}}\n' "$(openssl rand -hex 16)" \
    > "$dir/service-credentials.json"
chmod 644 "$dir/jwt/k1.pem" "$dir/service-credentials.json"

replace_placeholder() { # var, placeholder prefix, value
  if grep -q "^$1=$2" "$env_file"; then sed -i "s|^$1=.*|$1=$3|" "$env_file"; fi
}
replace_placeholder CORE_JWT_KEYS_DIR /abs/path "$dir/jwt"
replace_placeholder CORE_SERVICE_CREDENTIALS /abs/path "$dir/service-credentials.json"
replace_placeholder CORE_ENCRYPTION_KEY change-me "$(openssl rand -base64 32)"

# The importer authenticates to core as client_id "importer"; core reads the same secret from
# service-credentials.json, so both sides are written from one value.
grep -q '^IMPORTER_SERVICE_SECRET=' "$env_file" || echo 'IMPORTER_SERVICE_SECRET=change-me' >> "$env_file"
replace_placeholder IMPORTER_SERVICE_SECRET change-me "$(openssl rand -hex 24)"
importer_secret=$(grep '^IMPORTER_SERVICE_SECRET=' "$env_file" | cut -d= -f2-)
creds="$dir/service-credentials.json"
tmp=$(mktemp)
jq --arg s "$importer_secret" \
  '.importer = {secret: $s, scopes: (.importer.scopes // ["contacts:view", "contacts:edit"])}' \
  "$creds" > "$tmp" && mv "$tmp" "$creds"
chmod 644 "$creds"

# Per-machine overrides no clone should carry (say, a host where port 8080 is taken):
# KEY=VALUE lines in ~/.config/open-emarsys/local.env win over .env.example's defaults.
local_env="${OE_LOCAL_ENV:-$HOME/.config/open-emarsys/local.env}"
if [ -f "$local_env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in '' | \#*) continue ;; esac
    if grep -q "^$key=" "$env_file"; then sed -i "s|^$key=.*|$key=$value|" "$env_file"; else echo "$key=$value" >> "$env_file"; fi
  done < "$local_env"
fi
