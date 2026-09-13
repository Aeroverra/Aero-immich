# Aero-immich fork

This fork carries a small set of features on top of upstream [immich-app/immich](https://github.com/immich-app/immich) and ships them as a Docker image for the family instance. Everything fork-specific (this folder, the branch list, the workflows, the scripts) lives only on the `main` branch so it never collides with upstream.

Images are cut from **upstream releases**, never from upstream `main`: every upstream release tag `vX.Y.Z` becomes a fork release `vX.Y.Z-aero` after a one-click approval.

## Branch model

| Branch | What it is | Who writes to it |
|---|---|---|
| `upstream-main` | Pure mirror of upstream. Never committed to directly, only fast-forwarded (to the release tag being integrated). | the release workflow |
| `feat/*`, `fix/*` | One branch per upstream-PR-able change. Always **rebased** (never merged) onto the current upstream tag, so each stays a clean PR candidate. | you, plus the release workflow (rebase only) |
| `main` | Disposable integration branch and the repository default: upstream tag + a merge of every branch listed in `.github/aero-branches.txt`, in order, plus one "fork glue" commit (this folder, the workflows, the scripts, the branch list). Rebuilt from scratch by automation. The Docker image is built from it. | the release workflow (and the initial setup) |

Do not develop on `main`. Anything you commit there other than the glue paths (`.github/workflows/aero-release.yml`, `.github/workflows/aero-dry-run.yml`, `.github/scripts/`, `.github/aero-branches.txt`, `docs-aero/`) is thrown away on the next integration.

Never use GitHub's "Sync fork" button on this repository. It would merge upstream into the integration `main` instead of rebuilding it; the release workflow is the replacement.

### Stacked branches

`.github/aero-branches.txt` lists one branch per line, in stacking order, with an optional parent:

```
feat/private-mode
feat/private-mode-sync-compat feat/private-mode
fix/event-manager-listener-drop
```

A branch without a parent is rebased straight onto the upstream tag. A branch with a parent is rebased onto the parent's freshly rebased tip (`git rebase --onto <new parent> <old parent> <branch>`), so a stack survives the rebase as long as the child was already rebased onto the parent's current tip. If the parent gained commits the child does not have yet, rebase the child onto the parent locally first, otherwise the integration stops at the conflict.

## Adding a feature branch

1. Branch from the current upstream tag: `git fetch upstream --no-tags "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z" && git checkout -b feat/my-thing vX.Y.Z` (or from the parent branch if it stacks on one). `upstream-main` points at that tag too.
2. Push it to `origin`.
3. On `main`, append it to `.github/aero-branches.txt` (add the parent as a second column if it stacks), commit, push `main`.
4. The branch is merged in on the next integration. To ship it before the next upstream release, force the current tag: Actions, **Aero release**, Run workflow, `tag` = the current `vX.Y.Z`. That rebuilds `main`, builds a new release candidate and asks for approval again (see below).
5. When the change lands upstream, delete the branch and remove its line.

## The release flow: `.github/workflows/aero-release.yml`

Runs every 6 hours and on manual dispatch (inputs `tag`, `dry_run`).

```
detect ──new tag──> integrate ──ok──> candidate ──> [approval] ──> publish
   │                    │                                 
   └─ nothing new       └─ conflict / failing check: issue "Upstream <tag>: integration failed", nothing pushed
```

**`detect`** asks the GitHub API for the latest upstream release (`repos/immich-app/immich/releases/latest`, which never returns prereleases or drafts) and stops, with a log line, when:

- the fork already has a release `<tag>-aero` (that git tag is the "processed" marker), or
- an issue `Upstream <tag>: ready for release` is open (a candidate is built and waiting for your approval).

Dispatching with `tag` skips both checks and forces that tag.

**`integrate`** checks out `main` with the `AERO_SYNC_TOKEN` secret and runs `.github/scripts/aero-integrate.sh integrate <tag commit>`, which, without pushing anything:

1. fetches the tag and checks that `upstream-main` is an ancestor of it (`upstream-main` must never diverge),
2. rebases every listed branch in order onto the tag, stacked ones onto their rebased parent,
3. recreates `main` = tag + `git merge --no-ff` of each branch in order, then re-applies the glue paths from the previous `main` tip as one commit `chore(aero): fork glue (workflows, scripts, branch list, docs)`.

Then it runs the checks on the rebuilt `main` with upstream's own toolchain (mise): server `install`, `plugins`, `check` (tsc), `test --run` (unit tests), then sdk build and web `check-typescript`.

- **Any conflict or failing check**: the job opens or updates the issue `Upstream <tag>: integration failed` with the branch, the conflicting files (or the failing check with the last 80 log lines) and the exact local commands to fix it, and fails. Nothing is pushed; `upstream-main`, the branches and `main` are untouched.
- **Success**: `aero-integrate.sh push` pushes `upstream-main` (fast-forward to the tag), each rebased branch (`--force-with-lease` against the tip it started from) and `main` (`--force-with-lease`, only when its tree changed), and closes an earlier "integration failed" issue for that tag.

**`candidate`** builds `server/Dockerfile` from the new `main` (context `.`, `linux/amd64`, upstream's build args `DEVICE=cpu`, `BUILD_ID`, `BUILD_IMAGE`, `BUILD_SOURCE_REF`, `BUILD_SOURCE_COMMIT`, layer cache in the Actions cache) and pushes **only** the release-candidate tags to `ghcr.io/aeroverra/immich-server`:

- `<tag>-aero-rc`
- `<tag>-aero-rc-<short sha of main>`

It first verifies that `machine-learning/` is identical to the upstream tag and fails otherwise (reminder to add an ML build before shipping such a change). Then it opens or updates the issue `Upstream <tag>: ready for release` with the upstream release link, the branch tips, the check results, the rc tags and a link to the run whose `publish` job is waiting.

**`publish`** runs in the `release` environment, so it waits for a required reviewer. GitHub emails you a deployment review request; approve it from the email, the issue link or the run page. On approval it:

1. retags the rc image as `ghcr.io/aeroverra/immich-server:<tag>-aero` and `:aero` with `docker buildx imagetools create` (no rebuild, same digest),
2. creates the GitHub release `<tag>-aero` on the fork (target: the `main` commit, notes: upstream release link, fork branch table, checks, image tags). Its git tag is what marks the upstream tag as processed,
3. closes the "ready for release" issue with a comment.

Rejecting the deployment leaves the rc image in place and the issue open, so the 6-hour schedule leaves that tag alone. To get a new candidate later (after fixing a branch, say), close the issue or dispatch with `tag`.

`dry_run` on dispatch runs `detect` and `integrate` (rebase, rebuild, checks) and stops there: no push, no image, no issue.

### Image tags

| Tag | Meaning |
|---|---|
| `<tag>-aero` (for example `v3.2.0-aero`) | approved release built from upstream `<tag>` plus the fork branches; use this at home |
| `aero` | the most recently approved release |
| `<tag>-aero-rc`, `<tag>-aero-rc-<sha>` | candidates waiting for (or refused) approval; try one before approving if you like |

The machine-learning image is never built here. The family instance keeps upstream's `ghcr.io/immich-app/immich-machine-learning`.

## The weekly dry run: `.github/workflows/aero-dry-run.yml`

Every Monday (and on dispatch) the same `aero-integrate.sh integrate` runs against upstream **`main`** instead of a tag, pushes nothing and builds nothing. It is an early warning for the next release:

- on a conflict it opens or updates `Upcoming conflict with upstream main: <branch>` with the files and the fix commands,
- on a clean run it closes every open issue with that title prefix and just logs.

Fixing those early is optional; a branch only has to rebase cleanly onto the next release tag. The dry run does not run the test suites.

## Required setup (one time, repository owner)

- **Secret `AERO_SYNC_TOKEN`**: a fine-grained personal access token scoped to this repository with `Contents: Read and write`. The `integrate` job pushes with it. (`GITHUB_TOKEN` is used for everything else: GHCR, issues, the release.)
- **Environment `release`**: Settings, Environments, New environment, name `release`, enable **Required reviewers** and add yourself, save. Nothing else (no secrets, no branch restriction needed; if you restrict deployment branches, allow `main`). The repository is public, so environments are free. Without this environment the `publish` job runs unattended, which is exactly what the gate is there to prevent.
- **GHCR package visibility**: after the first candidate push the `immich-server` package under the `Aeroverra` account is private by default. Make it public (package settings, Danger zone, Change visibility) or configure the family instance's Docker host with a `docker login ghcr.io` using a read-only token.
- Never use GitHub's **Sync fork** button.

`main` is already the repository default branch, which is what lets GitHub run the scheduled workflows from it.

## Deploying at home

Only the server container changes. Machine learning, Postgres and Redis/Valkey stay exactly as upstream's `docker-compose.yml` has them.

```yaml
services:
  immich-server:
    image: ghcr.io/aeroverra/immich-server:v3.2.0-aero   # the approved fork release
    # everything else unchanged

  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.2.0   # upstream, same version
    # unchanged: the fork does not modify the ML image
```

Then on the aero-docker host `docker compose pull immich-server && docker compose up -d immich-server`. Using the pinned `<tag>-aero` tag (rather than `aero`) means the instance moves only when you edit the compose file, after you approved the release and read its notes; the ML image should be bumped to the same upstream version at the same time.

The image's base version is visible in its tag and in the server's About dialog (`IMMICH_SOURCE_COMMIT` is the `main` commit).

## Recovering from a failed integration

The issue `Upstream <tag>: integration failed` tells you the branch, the conflicting files (or the failing check with its log tail) and the commands. In short:

```bash
git fetch upstream --no-tags "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"
git rebase vX.Y.Z feat/the-branch                 # or, for a stacked child:
git rebase --onto feat/parent <old parent tip> feat/the-child
# resolve, git rebase --continue, run the checks (cd server && pnpm check && pnpm test), then
git push --force-with-lease origin feat/the-branch
```

Then Actions, **Aero release**, Run workflow, `tag` = `vX.Y.Z`. The run rebases from the pushed tips, so a branch you already rebased is a no-op. The issue is closed automatically when the integration succeeds. Nothing needs cleaning up on the remote: a failed run pushes nothing.

If a **check** fails and the cause is upstream (a test that upstream shipped broken), the fix still goes on a fork branch (a `fix/*` branch listed in `.github/aero-branches.txt`) so `main` stays a pure rebuild.

## Forcing a tag

Actions, **Aero release**, Run workflow, `tag` = `vX.Y.Z` (any tag upstream has a release for). Use it to:

- retry after fixing a failed integration,
- ship a new fork branch on the current upstream version,
- rebuild a candidate that was rejected,
- integrate a specific older tag (only works while `upstream-main` is still an ancestor of it; the mirror is never rewound).

Forcing a tag that already has a fork release rebuilds the candidate and, on approval, moves `<tag>-aero` and `aero` to the new image and updates the release notes.

## Doing it by hand

The workflow is a thin wrapper around `.github/scripts/aero-integrate.sh`, which also runs locally from a clone whose `origin` is the fork:

```bash
git fetch upstream --no-tags "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"
bash .github/scripts/aero-integrate.sh integrate vX.Y.Z /tmp/aero-state   # rebase + rebuild main, no push
# run the checks on the rebuilt main, then
bash .github/scripts/aero-integrate.sh push /tmp/aero-state
```

Exit code 2 means a rebase/merge conflict (details in `/tmp/aero-state/result.env` and `conflict-files.txt`). The image build and the release are only done by the workflow.

## Rolling back to upstream

Point `image:` back to an upstream tag (`ghcr.io/immich-app/immich-server:release` or a specific `v3.x.y`) and `docker compose up -d immich-server`.

Caveat: the private-mode feature adds a database migration (`isPrivate` on assets and albums plus the private-mode session flag). An upstream image will not boot against a database that has migrations it does not know about. Before switching back, the private-mode migration has to be reverted with the separate uninstaller. That uninstaller is planned but not written yet; until it exists, rolling back means restoring a database backup taken before the fork image first started. Take that backup before the first switch.
