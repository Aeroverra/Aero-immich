#!/usr/bin/env bash
# Shared sync/rebase/merge logic of the Aero-immich fork. Lives only on `main`
# (fork glue, see docs-aero/README.md). Used by aero-release.yml and
# aero-dry-run.yml; can be run locally as well.
#
#   aero-integrate.sh integrate <target-commit> <state-dir>
#       Rebuilds everything locally, pushes nothing:
#         - checks that origin/upstream-main is an ancestor of <target-commit>
#         - rebases every branch in .github/aero-branches.txt (read from
#           origin/main) onto <target-commit>, stacked ones onto their rebased
#           parent
#         - recreates local branch `main` = <target-commit> + merge --no-ff of
#           every branch in order + one fork-glue commit taken from origin/main
#       Writes <state-dir>/result.env (shell key=value), <state-dir>/branches.tsv
#       (name, old tip, new tip, parent) and, on a conflict,
#       <state-dir>/conflict-files.txt. Exit code 2 means a rebase or merge
#       conflict (details in result.env), any other non-zero exit is a setup
#       error.
#
#   aero-integrate.sh push <state-dir>
#       Pushes what a previous `integrate` produced: upstream-main
#       (fast-forward), every rebased branch (--force-with-lease against the
#       tip it started from) and main (--force-with-lease, only when its tree
#       changed).
#
# Requirements: run from a clone whose `origin` is the fork with push access
# (for `push`), <target-commit> already fetched into the object store.
# Environment: AERO_GLUE_PATHS overrides the fork-only paths re-applied on top
# of the rebuilt main.

set -euo pipefail

AERO_GLUE_PATHS=${AERO_GLUE_PATHS:-".github/workflows/aero-release.yml .github/workflows/aero-dry-run.yml .github/scripts .github/aero-branches.txt docs-aero"}
BRANCH_LIST_PATH=.github/aero-branches.txt

usage() {
  echo "usage: $0 integrate <target-commit> <state-dir> | $0 push <state-dir>" >&2
  exit 64
}

log() { echo "[aero-integrate] $*"; }
# result.env is sourced by the workflows: every value is shell-quoted
kv() { printf '%s=%q\n' "$1" "$2"; }

group_start() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$*"; else log "$*"; fi; }
group_end() { if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi; }

# ---------------------------------------------------------------------------
integrate() {
  local target=$1 state=$2
  mkdir -p "$state"
  rm -f "$state/result.env" "$state/branches.tsv" "$state/conflict-files.txt"

  local result="$state/result.env"

  # abort helpers -----------------------------------------------------------
  setup_fail() {
    {
      kv status "error"
      kv message "$1"
    } > "$result"
    echo "::error::$1"
    exit 1
  }

  # conflict <kind> <branch> <onto-description> <message>
  conflict() {
    local kind=$1 branch=$2 onto=$3 message=$4
    git diff --name-only --diff-filter=U > "$state/conflict-files.txt" 2>/dev/null || true
    if [[ "$kind" == rebase ]]; then git rebase --abort >/dev/null 2>&1 || true; else git merge --abort >/dev/null 2>&1 || true; fi
    {
      kv status "conflict"
      kv conflict_kind "$kind"
      kv conflict_branch "$branch"
      kv conflict_onto "$onto"
      kv message "$message"
      kv target "$target"
      kv old_mirror "$OLD_MIRROR"
      kv old_main "$OLD_MAIN"
    } > "$result"
    echo "::error::$message"
    echo
    echo "Conflicting files:"
    sed 's/^/  /' "$state/conflict-files.txt"
    exit 2
  }

  git rev-parse --verify --quiet "$target^{commit}" >/dev/null || setup_fail "target commit $target is not in the object store; fetch it first."
  target=$(git rev-parse "$target^{commit}")

  git checkout -q --detach
  git fetch -q --no-tags origin upstream-main main
  OLD_MIRROR=$(git rev-parse origin/upstream-main)
  OLD_MAIN=$(git rev-parse origin/main)
  log "target               = $target"
  log "origin/upstream-main = $OLD_MIRROR"
  log "origin/main          = $OLD_MAIN"

  # upstream-main must be a pure mirror: only ever fast-forward it
  if ! git merge-base --is-ancestor "$OLD_MIRROR" "$target"; then
    setup_fail "origin/upstream-main ($OLD_MIRROR) is not an ancestor of the target ($target). upstream-main must never be committed to directly, and the target must be newer than the current mirror."
  fi

  # branch list, read from origin/main so it does not matter which ref is checked out
  local -a BRANCHES=() PARENTS=()
  local name parent _
  while read -r name parent _; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    BRANCHES+=("$name")
    PARENTS+=("${parent:-}")
  done < <(git show "origin/main:$BRANCH_LIST_PATH")
  [[ ${#BRANCHES[@]} -gt 0 ]] || setup_fail "$BRANCH_LIST_PATH on origin/main lists no branches."

  local -A OLD NEW
  for name in "${BRANCHES[@]}"; do
    git fetch -q --no-tags origin "$name" || setup_fail "branch $name does not exist on origin."
    OLD[$name]=$(git rev-parse "origin/$name")
    git branch -f "$name" "origin/$name"
  done

  # rebase in stacking order
  local i
  for i in "${!BRANCHES[@]}"; do
    name=${BRANCHES[$i]}
    parent=${PARENTS[$i]}
    if [[ -z "$parent" ]]; then
      group_start "rebase $name onto $target"
      if ! git rebase "$target" "$name"; then
        conflict rebase "$name" "$target" "Rebasing $name onto the new upstream commit ($target) hit conflicts."
      fi
    else
      [[ -n "${NEW[$parent]:-}" ]] || setup_fail "$name lists parent $parent, which must appear earlier in $BRANCH_LIST_PATH."
      group_start "rebase $name onto $parent (--onto ${NEW[$parent]} ${OLD[$parent]})"
      if ! git rebase --onto "${NEW[$parent]}" "${OLD[$parent]}" "$name"; then
        conflict rebase "$name" "$parent" "Rebasing $name onto the rebased $parent hit conflicts. Rebase $name onto $parent locally first."
      fi
    fi
    group_end
    NEW[$name]=$(git rev-parse "$name")
    log "$name: ${OLD[$name]} -> ${NEW[$name]}"
  done

  # rebuild main = target + merge of every branch, in order
  git checkout -q -B main "$target"
  for name in "${BRANCHES[@]}"; do
    group_start "merge $name into main"
    if ! git merge --no-ff -m "Merge $name into main" "$name"; then
      conflict merge "$name" main "Merging $name into main hit conflicts. The listed branches do not combine cleanly; fix the branches, not main."
    fi
    group_end
  done

  # re-apply the fork-only glue from the previous main tip
  local p
  for p in $AERO_GLUE_PATHS; do
    if git cat-file -e "$OLD_MAIN:$p" 2>/dev/null; then
      git checkout "$OLD_MAIN" -- "$p"
    fi
  done
  if ! git diff --cached --quiet; then
    git commit -q -m "chore(aero): fork glue (workflows, scripts, branch list, docs)"
  fi
  local NEW_MAIN
  NEW_MAIN=$(git rev-parse main)

  local main_changed=true
  if [[ "$(git rev-parse "$OLD_MAIN^{tree}")" == "$(git rev-parse "$NEW_MAIN^{tree}")" ]]; then
    main_changed=false
  fi

  {
    kv status "ok"
    kv target "$target"
    kv old_mirror "$OLD_MIRROR"
    kv old_main "$OLD_MAIN"
    kv new_main "$NEW_MAIN"
    kv main_changed "$main_changed"
    kv branch_count "${#BRANCHES[@]}"
  } > "$result"
  for i in "${!BRANCHES[@]}"; do
    name=${BRANCHES[$i]}
    printf '%s\t%s\t%s\t%s\n' "$name" "${OLD[$name]}" "${NEW[$name]}" "${PARENTS[$i]}" >> "$state/branches.tsv"
  done

  log "main: $OLD_MAIN -> $NEW_MAIN (tree changed: $main_changed)"
  log "integration succeeded; nothing pushed."
}

# ---------------------------------------------------------------------------
push() {
  local state=$1
  [[ -f "$state/result.env" ]] || { echo "::error::$state/result.env missing; run integrate first." >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$state/result.env"
  [[ "${status:-}" == ok ]] || { echo "::error::last integrate did not succeed (status=${status:-unknown}); refusing to push." >&2; exit 1; }

  local name old new parent
  if [[ "$old_mirror" != "$target" ]]; then
    log "push upstream-main: $old_mirror -> $target"
    git push origin "$target:refs/heads/upstream-main"
  fi
  while IFS=$'\t' read -r name old new parent; do
    if [[ "$old" != "$new" ]]; then
      log "push $name: $old -> $new"
      git push --force-with-lease="refs/heads/$name:$old" origin "$new:refs/heads/$name"
    fi
  done < "$state/branches.tsv"
  if [[ "$main_changed" == true ]]; then
    log "push main: $old_main -> $new_main"
    git push --force-with-lease="refs/heads/main:$old_main" origin "$new_main:refs/heads/main"
  else
    log "main tree unchanged; not rewriting the branch"
  fi
}

# ---------------------------------------------------------------------------
case "${1:-}" in
  integrate) [[ $# -eq 3 ]] || usage; integrate "$2" "$3" ;;
  push) [[ $# -eq 2 ]] || usage; push "$2" ;;
  *) usage ;;
esac
