#!/usr/bin/env bash
# Open/update/close GitHub issues on the fork by exact title. Fork glue, lives
# only on `main`. Needs `gh` with GH_TOKEN (issues: write) and GITHUB_REPOSITORY.
#
#   aero-issue.sh upsert "<title>" <body-file>
#       Creates the issue, or replaces the body of the open issue with that
#       exact title and adds a comment saying it was updated. Prints the issue
#       number.
#   aero-issue.sh close "<title>" "<comment>"
#       Closes every open issue with that exact title, commenting first.
#       Prints nothing and succeeds when there is none.
#   aero-issue.sh close-prefix "<title prefix>" "<comment>"
#       Same, for every open issue whose title starts with the prefix.
#   aero-issue.sh find "<title>"
#       Prints the number of the open issue with that exact title, or nothing.

set -euo pipefail

REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}

find_open() {
  # exact-title match; --search is fuzzy so filter with jq
  gh issue list -R "$REPO" --state open --limit 100 --search "\"$1\" in:title" --json number,title \
    | jq -r --arg t "$1" '.[] | select(.title == $t) | .number'
}

find_open_prefix() {
  gh issue list -R "$REPO" --state open --limit 100 --search "\"$1\" in:title" --json number,title \
    | jq -r --arg t "$1" '.[] | select(.title | startswith($t)) | .number'
}

case "${1:-}" in
  upsert)
    title=$2 body=$3
    existing=$(find_open "$title" | head -n1)
    if [[ -n "$existing" ]]; then
      gh issue edit -R "$REPO" "$existing" --body-file "$body" >/dev/null
      gh issue comment -R "$REPO" "$existing" --body "Updated by workflow run ${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-0} (issue body replaced with the latest result)." >/dev/null
      echo "$existing"
    else
      gh issue create -R "$REPO" --title "$title" --body-file "$body" | sed -E 's#.*/issues/##'
    fi
    ;;
  close)
    title=$2 comment=$3
    for n in $(find_open "$title"); do
      gh issue comment -R "$REPO" "$n" --body "$comment" >/dev/null
      gh issue close -R "$REPO" "$n" >/dev/null
      echo "closed #$n ($title)"
    done
    ;;
  close-prefix)
    prefix=$2 comment=$3
    for n in $(find_open_prefix "$prefix"); do
      gh issue comment -R "$REPO" "$n" --body "$comment" >/dev/null
      gh issue close -R "$REPO" "$n" >/dev/null
      echo "closed #$n"
    done
    ;;
  find)
    find_open "$2" | head -n1
    ;;
  *)
    echo "usage: $0 upsert <title> <body-file> | close <title> <comment> | close-prefix <prefix> <comment> | find <title>" >&2
    exit 64
    ;;
esac
