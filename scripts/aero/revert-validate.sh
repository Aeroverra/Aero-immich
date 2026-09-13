#!/usr/bin/env bash
# Fork glue (lives only on `main`). End-to-end check that
# scripts/aero/revert-to-immich.sql really turns a database migrated by the
# fork image back into one upstream Immich boots on cleanly.
#
#   revert-validate.sh <fork-image> <upstream-tag>
#
#   e.g. revert-validate.sh ghcr.io/aeroverra/immich-server:v3.2.0-aero-rc v3.2.0
#
# What it does, with throwaway containers on a private docker network:
#   1. fresh postgres (upstream's image) + valkey
#   2. boots <fork-image> until its migrations ran and the schema check passed,
#      asserts the fork rows/columns exist, stops it
#   3. runs the SQL once WITHOUT the token (must refuse), then WITH it, then
#      once more (must be idempotent)
#   4. boots ghcr.io/immich-app/immich-server:<upstream-tag> against the same
#      database and asserts: "Finished running migrations" with no migration
#      executed, "No schema drift detected", `immich-admin schema-check` clean,
#      no fork column / row left
# Exit 0 on success. Everything it created is removed on exit (also on failure).
#
# Environment (all optional):
#   AERO_REVERT_ID   suffix for container/network/volume names (default: pid)
#   PG_PORT          publish postgres on this host port (default: not published)
#   POSTGRES_IMAGE, REDIS_IMAGE   override the database / cache images
#   KEEP_LOGS_DIR    copy every container's log into this directory on exit

set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep /tmp/... container paths intact

fork_image=${1:-}
upstream_tag=${2:-}
[[ -n "$fork_image" && -n "$upstream_tag" ]] || { echo "usage: $0 <fork-image> <upstream-tag>" >&2; exit 64; }

root=$(git rev-parse --show-toplevel)
sql=$root/scripts/aero/revert-to-immich.sql
[[ -f "$sql" ]] || { echo "::error::$sql not found" >&2; exit 64; }

id=${AERO_REVERT_ID:-$$}
net=aero-revert-$id
db=aero-revert-db-$id
redis=aero-revert-redis-$id
server=aero-revert-server-$id
vol=aero-revert-data-$id
POSTGRES_IMAGE=${POSTGRES_IMAGE:-ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23}
REDIS_IMAGE=${REDIS_IMAGE:-docker.io/valkey/valkey:9}
upstream_image=ghcr.io/immich-app/immich-server:$upstream_tag
DB_USERNAME=postgres DB_PASSWORD=postgres DB_DATABASE_NAME=immich

log() { echo "[revert-validate] $*"; }
fail() { echo "::error::$*" >&2; exit 1; }
group_start() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$*"; else log "$*"; fi; }
group_end() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi; }

psql_db() { docker exec -i "$db" psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -v ON_ERROR_STOP=1 "$@"; }
query() { psql_db -Atc "$1"; }

cleanup() {
  local rc=$?
  set +e
  if [[ -n "${KEEP_LOGS_DIR:-}" ]]; then
    mkdir -p "$KEEP_LOGS_DIR"
    for c in "$server" "$db" "$redis"; do
      docker logs "$c" > "$KEEP_LOGS_DIR/$c.log" 2>&1
    done
  fi
  docker rm -f "$server" "$db" "$redis" >/dev/null 2>&1
  docker volume rm "$vol" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
  [[ $rc -eq 0 ]] && log "cleanup done" || log "cleanup done (exit $rc)"
  exit $rc
}
trap cleanup EXIT

# server_log: the server container's log with ANSI colours stripped. Always
# snapshot into a variable before grepping: `docker logs | grep -q` under
# pipefail reports the SIGPIPE as a miss.
server_log() { docker logs "$server" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' || true; }
log_has() { grep -qE "$1" <<<"$(server_log)"; }

# poll_log <pattern> <seconds>: 0 once the server log matches, 1 on timeout,
# 2 if the container died first
poll_log() {
  local pattern=$1 deadline=$(( $(date +%s) + $2 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if log_has "$pattern"; then return 0; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$server" 2>/dev/null)" == true ]] || return 2
    sleep 2
  done
  return 1
}

# wait_for_log <pattern> <seconds>: like poll_log but fatal
wait_for_log() {
  local rc=0
  poll_log "$1" "$2" || rc=$?
  [[ $rc -eq 0 ]] && return 0
  server_log | tail -n 60
  [[ $rc -eq 2 ]] && fail "server container exited before logging '$1'"
  fail "server did not log '$1' within $2s"
}

# boot_server <image> <phase> <geodata-wait>: starts the server and waits for
# its bootstrap (migrations + drift check). The first boot also imports the
# geodata tables in the background (drop + recreate + primary keys); stopping
# the container mid-import, or running schema-check during it, gives random
# drift reports, so wait for "Geodata import completed". Later boots of the
# same geodata version skip the import silently, hence the bounded wait.
boot_server() {
  local image=$1 phase=$2 geodata_wait=$3
  docker run -d --name "$server" --network "$net" \
    -e DB_HOSTNAME="$db" -e DB_USERNAME="$DB_USERNAME" -e DB_PASSWORD="$DB_PASSWORD" -e DB_DATABASE_NAME="$DB_DATABASE_NAME" \
    -e REDIS_HOSTNAME="$redis" \
    -e IMMICH_MACHINE_LEARNING_ENABLED=false \
    -e IMMICH_IGNORE_MOUNT_CHECK_ERRORS=true \
    -e IMMICH_TELEMETRY_INCLUDE= \
    -v "$vol:/data" \
    "$image" >/dev/null
  wait_for_log 'Finished running migrations' 240
  wait_for_log 'schema drift' 120
  wait_for_log 'Immich Server is listening' 120
  if poll_log 'Geodata import completed' "$geodata_wait"; then
    log "$phase: geodata import completed"
  else
    log "$phase: no geodata import logged within ${geodata_wait}s, assuming it was skipped (already current)"
  fi
  log "$phase: server up ($image)"
}

stop_server() { docker rm -f "$server" >/dev/null; }

server_log_excerpt() {
  grep -E 'Running migrations|Migration "|Finished running migrations|schema drift|is listening|Geodata import' <<<"$(server_log)" || true
}

# ---------------------------------------------------------------------------
group_start "start postgres and valkey"
docker network create "$net" >/dev/null
docker volume create "$vol" >/dev/null
db_publish=()
[[ -n "${PG_PORT:-}" ]] && db_publish=(-p "127.0.0.1:$PG_PORT:5432")
docker run -d --name "$db" --network "$net" "${db_publish[@]}" \
  -e POSTGRES_USER="$DB_USERNAME" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB="$DB_DATABASE_NAME" \
  -e POSTGRES_INITDB_ARGS=--data-checksums \
  "$POSTGRES_IMAGE" >/dev/null
docker run -d --name "$redis" --network "$net" "$REDIS_IMAGE" >/dev/null
for _ in $(seq 1 90); do
  docker exec "$db" pg_isready -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -q >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$db" pg_isready -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -q || { docker logs "$db"; fail "postgres not ready"; }
group_end

# ---------------------------------------------------------------------------
group_start "phase 1: boot the fork image $fork_image (applies the fork migrations)"
boot_server "$fork_image" fork 300
server_log_excerpt
fork_rows=$(query "SELECT count(*) FROM kysely_migrations WHERE name LIKE '%PrivateMode%'")
[[ "$fork_rows" -ge 1 ]] || fail "the fork image applied no PrivateMode migration; is $fork_image really a fork build?"
[[ "$(query "SELECT count(*) FROM information_schema.columns WHERE table_name='asset' AND column_name='isPrivate'")" == 1 ]] || fail "asset.isPrivate missing after the fork boot"
overrides=$(query "SELECT count(*) FROM migration_overrides WHERE name LIKE '%\_private\_%'")
log "fork: $fork_rows PrivateMode migration row(s), $overrides private-mode override row(s), asset.isPrivate present"
if ! log_has 'No schema drift detected'; then
  grep -A20 'schema drift' <<<"$(server_log)" | head -n 40 || true
  fail "the fork image itself reports schema drift; fix the feature branch before validating the revert"
fi
# seed a user whose preferences carry the fork's privateMode block next to an
# upstream key, so the revert has something to strip and something to keep
docker exec "$server" curl -fsS -o /dev/null -X POST http://localhost:2283/api/auth/admin-sign-up \
  -H 'content-type: application/json' \
  -d '{"email":"revert@example.com","password":"RevertValidation1!","name":"revert"}' || fail "admin sign-up on the fork server failed"
uid=$(query "SELECT id FROM \"user\" WHERE email = 'revert@example.com'")
[[ -n "$uid" ]] || fail "admin user not found after sign-up"
query "INSERT INTO user_metadata (\"userId\", key, value) VALUES ('$uid', 'preferences', '{\"privateMode\":{\"timeoutMinutes\":5},\"memories\":{\"enabled\":false}}'::jsonb)
       ON CONFLICT (\"userId\", key) DO UPDATE SET value = user_metadata.value || excluded.value" >/dev/null
[[ "$(query "SELECT count(*) FROM user_metadata WHERE key='preferences' AND value ? 'privateMode'")" == 1 ]] || fail "seeding the privateMode preference failed"
log "fork: seeded user $uid with a privateMode preference"
stop_server
group_end

# ---------------------------------------------------------------------------
group_start "phase 2: run revert-to-immich.sql"
docker cp "$sql" "$db:/tmp/revert-to-immich.sql"
if docker exec "$db" psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -v ON_ERROR_STOP=1 -f /tmp/revert-to-immich.sql >/dev/null 2>&1; then
  fail "the script ran WITHOUT the aero.revert_token acknowledgement; the safety check is broken"
fi
[[ "$(query "SELECT count(*) FROM kysely_migrations WHERE name LIKE '%PrivateMode%'")" == "$fork_rows" ]] || fail "the refused run changed the database"
log "refused without the token, database untouched"
run_revert() {
  docker exec "$db" psql -U "$DB_USERNAME" -d "$DB_DATABASE_NAME" -v ON_ERROR_STOP=1 \
    -c "SET aero.revert_token = 'i_accept_data_loss';" \
    -f /tmp/revert-to-immich.sql
}
run_revert
log "revert applied"
run_revert >/dev/null
log "second run succeeded (idempotent)"
[[ "$(query "SELECT count(*) FROM kysely_migrations WHERE name LIKE '%PrivateMode%'")" == 0 ]] || fail "PrivateMode rows still in kysely_migrations"
[[ "$(query "SELECT count(*) FROM information_schema.columns WHERE column_name IN ('isPrivate','privateModeExpiresAt')")" == 0 ]] || fail "fork columns still present"
[[ "$(query "SELECT count(*) FROM migration_overrides WHERE name LIKE '%\_private\_%'")" == 0 ]] || fail "fork migration_overrides rows still present"
[[ "$(query "SELECT count(*) FROM user_metadata WHERE key='preferences' AND value ? 'privateMode'")" == 0 ]] || fail "privateMode still in user preferences"
[[ "$(query "SELECT value->'memories'->>'enabled' FROM user_metadata WHERE \"userId\" = '$uid' AND key = 'preferences'")" == false ]] || fail "the revert damaged upstream preference keys"
log "user preferences: privateMode stripped, other keys kept"
group_end

# ---------------------------------------------------------------------------
group_start "phase 3: boot upstream $upstream_image against the reverted database"
boot_server "$upstream_image" upstream 60
server_log_excerpt
if log_has 'Migration ".*" (succeeded|failed)'; then
  fail "upstream ran or failed a migration on the reverted database; it should have had nothing to do"
fi
if ! log_has 'No schema drift detected'; then
  grep -A20 'schema drift' <<<"$(server_log)" | head -n 40 || true
  fail "upstream reports schema drift after the revert"
fi
report=$(docker exec "$server" immich-admin schema-check 2>&1 || true)
echo "$report"
grep -q 'Migrations are up to date' <<<"$report" || fail "immich-admin schema-check: migrations not up to date"
grep -q 'No schema drift detected' <<<"$report" || fail "immich-admin schema-check: drift detected"
asset_desc=$(psql_db -c '\d asset')
grep -q 'isPrivate' <<<"$asset_desc" && fail "\\d asset still lists isPrivate"
log "\\d asset has no isPrivate column"
stop_server
group_end

log "PASSED: $fork_image -> revert-to-immich.sql -> $upstream_image boots clean"
