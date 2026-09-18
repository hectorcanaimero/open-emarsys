#!/usr/bin/env bash
# Waits for `make up`: long-running services must be running (and healthy when they have a
# healthcheck), one-shot *-init/*-migrate containers must have exited 0. `docker compose up --wait`
# cannot express the second part: it treats an init container that finished as a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -f deploy/compose/docker-compose.yml)
deadline=$((SECONDS + ${WAIT_TIMEOUT:-600}))

while :; do
  pending=0
  while read -r svc state health code; do
    case "$svc" in
      *-init|*-migrate)
        if [ "$state" = exited ] && [ "$code" != 0 ]; then echo "$svc exited with $code" >&2; exit 1; fi
        [ "$state" = exited ] || pending=1 ;;
      *)
        if [ "$health" = unhealthy ] || [ "$state" = exited ]; then echo "$svc is $state${health:+ ($health)}" >&2; exit 1; fi
        # A crash loop can be caught while "running"; any restart means it is not up.
        restarts=$(docker inspect -f '{{.RestartCount}}' "$("${compose[@]}" ps -q "$svc")" 2>/dev/null || echo 0)
        if [ "${restarts:-0}" -gt 0 ]; then echo "$svc restarted $restarts time(s): see docker logs" >&2; exit 1; fi
        { [ "$state" = running ] && [ "$health" != starting ]; } || pending=1 ;;
    esac
  done < <("${compose[@]}" ps -a --format '{{.Service}} {{.State}} {{if .Health}}{{.Health}}{{else}}-{{end}} {{.ExitCode}}')
  [ "$pending" = 0 ] && { echo "platform is up"; exit 0; }
  [ "$SECONDS" -lt "$deadline" ] || { echo "timed out waiting for the platform" >&2; "${compose[@]}" ps -a >&2; exit 1; }
  sleep 3
done
