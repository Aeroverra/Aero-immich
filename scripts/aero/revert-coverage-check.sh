#!/usr/bin/env bash
# Fork glue (lives only on `main`). Asserts that scripts/aero/revert-to-immich.sql
# deletes the kysely_migrations row of every fork migration, and of nothing
# upstream ships.
#
#   revert-coverage-check.sh <upstream-ref>
#
# <upstream-ref> is the upstream tag (or any ref) the fork is currently built
# on, for example v3.2.0. It must be present in the local object store
# (git fetch upstream --no-tags "+refs/tags/v3.2.0:refs/tags/v3.2.0").
#
# Fork migrations = every migration file in server/src/schema/migrations-aero
# of the checked out tree (feat/aero-migrations: fork schema changes never go
# into upstream's folder). Each must appear as '<name>' in the DELETE FROM
# "kysely_migrations" list of the SQL. Conversely, no name in that list may
# exist upstream, or the revert would delete a row upstream expects and its
# migrator would re-run that migration. As a guard, server/src/schema/migrations
# must hold exactly the files it holds at <upstream-ref>: a fork migration that
# slipped into upstream's folder would be invisible to this check.
#
# Exit 0 when everything matches, 1 otherwise, 64 on usage errors.

set -euo pipefail

ref=${1:-}
[[ -n "$ref" ]] || { echo "usage: $0 <upstream-ref>" >&2; exit 64; }

root=$(git rev-parse --show-toplevel)
sql=$root/scripts/aero/revert-to-immich.sql
dir=server/src/schema/migrations
fork_dir=server/src/schema/migrations-aero

git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || { echo "::error::$ref is not in the object store; fetch it first." >&2; exit 64; }
[[ -f "$sql" ]] || { echo "::error::$sql not found" >&2; exit 64; }

upstream=$(git ls-tree --name-only "$ref" -- "$dir/" | sed 's#.*/##' | grep -E '\.ts$' | sed 's/\.ts$//' | sort)
local_files=$(cd "$root" && find "$dir" -maxdepth 1 -type f -name '*.ts' -printf '%f\n' | sed 's/\.ts$//' | sort)
fork=$(cd "$root" && find "$fork_dir" -maxdepth 1 -type f -name '*.ts' -printf '%f\n' 2>/dev/null | sed 's/\.ts$//' | sort)
listed=$(sed -n '/^DELETE FROM "kysely_migrations"/,/^ *);/p' "$sql" | grep -oE "'[0-9]+-[A-Za-z0-9_.]+'" | tr -d "'" | sort -u)

echo "upstream ref:      $ref ($(echo "$upstream" | grep -c . ) migrations)"
echo "fork migrations:   $(echo "$fork" | grep -c . || true) (in $fork_dir)"
echo "listed in the SQL: $(echo "$listed" | grep -c . || true)"

rc=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  echo "::error file=$dir/$name.ts::$name is not shipped by upstream $ref; fork migrations belong in $fork_dir (see $fork_dir/README.md)"
  rc=1
done < <(comm -23 <(echo "$local_files") <(echo "$upstream"))

while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if ! grep -qxF "$name" <<<"$listed"; then
    echo "::error file=scripts/aero/revert-to-immich.sql::fork migration $name is not deleted from kysely_migrations by the revert script"
    rc=1
  fi
done <<<"$fork"

while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if grep -qxF "$name" <<<"$upstream"; then
    echo "::error file=scripts/aero/revert-to-immich.sql::$name is shipped by upstream $ref; the revert script must not delete its kysely_migrations row"
    rc=1
  fi
  if ! grep -qxF "$name" <<<"$fork"; then
    echo "::warning file=scripts/aero/revert-to-immich.sql::$name is listed in the revert script but no such fork migration file exists (stale entry?)"
  fi
done <<<"$listed"

if [[ $rc -eq 0 ]]; then
  echo "revert coverage ok: every fork migration is reverted, nothing upstream is touched, upstream's folder is pristine"
fi
exit $rc
