#!/usr/bin/env bash
# Fork revision numbers of the Aero-immich fork. Fork glue, lives only on
# `main` (see docs-aero/README.md, "Versioning"). Used by aero-release.yml.
#
# Every publish of the same upstream tag gets its own immutable revision:
# release / git tag / image tag `<tag>-aero.N`, N = 1, 2, 3 ... per upstream
# tag. The bare release `<tag>-aero` (created by the first publish, before
# revisions existed) counts as revision 1. The revision is derived from the
# releases that exist on the fork, so it is the same wherever it is computed.
#
#   aero-revision.sh latest <tag>
#       Prints the highest published revision of <tag> (0 when the fork has
#       no release for it).
#   aero-revision.sh next <tag>
#       Prints the revision the next publish of <tag> will create (latest + 1).
#
# Needs `gh` with GH_TOKEN (contents: read) and GITHUB_REPOSITORY. Sourcing
# the file only defines the functions (max_revision reads release tag names
# from stdin, one per line), which is how it is tested.

max_revision() {
  local tag=$1 max=0 n name
  while IFS= read -r name; do
    if [[ "$name" == "$tag-aero" ]]; then
      n=1
    elif [[ "$name" =~ ^"$tag"-aero\.([0-9]+)$ ]]; then
      n=${BASH_REMATCH[1]}
    else
      continue
    fi
    if (( n > max )); then max=$n; fi
  done
  echo "$max"
}

list_release_tags() {
  gh api --paginate "repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}/releases?per_page=100" --jq '.[].tag_name'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  [[ $# -eq 2 ]] || { echo "usage: $0 latest <tag> | next <tag>" >&2; exit 64; }
  # a failed listing must fail the script (pipefail on the assignment), never
  # come out as revision 1
  latest=$(list_release_tags | max_revision "$2")
  case "$1" in
    latest) echo "$latest" ;;
    next) echo $((latest + 1)) ;;
    *) echo "usage: $0 latest <tag> | next <tag>" >&2; exit 64 ;;
  esac
fi
