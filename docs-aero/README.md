# Aero-immich fork

This fork carries a small set of features on top of upstream [immich-app/immich](https://github.com/immich-app/immich) and ships them as a Docker image for the family instance. Everything fork-specific (this folder, the branch list, the workflows, the scripts) lives only on the `main` branch so it never collides with upstream.

Images are cut from **upstream releases**, never from upstream `main`: every upstream release tag `vX.Y.Z` becomes a fork release `vX.Y.Z-aero.N` after a one-click approval (see [Versioning](#versioning)).

## Versioning

A fork release is identified by two numbers, the way a distro package is: the **upstream version** it is built from (`vX.Y.Z`, upstream's release tag) and the **fork revision** `N` (1, 2, 3 ... per upstream version, one per approved publish). Together they form the release name `vX.Y.Z-aero.N`. The revision goes up whenever the same upstream version is published again, which happens when a fork branch changed and the current tag was forced (see [Forcing a tag](#forcing-a-tag)); two revisions of the same upstream version therefore differ only in fork branches, never in upstream code.

The server keeps reporting the plain upstream version (`vX.Y.Z` in the About dialog and the `/api/server/version` endpoint): the mobile apps check it for compatibility with their own version, so the fork revision must not leak into it. The revision is visible only in the tags below and in the release notes, which list the exact branch commits the revision contains.

| Tag | Kind | Meaning |
|---|---|---|
| `vX.Y.Z-aero.N` (image, GitHub release, git tag) | immutable | one approved publish; never edited, never moved. **Pin this at home.** |
| `vX.Y.Z-aero` (image only) | moving | the latest fork revision of upstream `vX.Y.Z`; retagged on every publish of that version |
| `aero` (image only) | moving | the latest fork release of any upstream version; retagged on every publish |
| `vX.Y.Z-aero-rc`, `vX.Y.Z-aero-rc-<sha>` (image only) | candidate | built by every run, waiting for (or refused) approval |

Historical exception: the first fork release was published before revisions existed, as the release and git tag `v3.2.0-aero`. It is revision 1 of `v3.2.0` (the pipeline counts it as `v3.2.0-aero.1`; the next publish of `v3.2.0` is `v3.2.0-aero.2`) and is left as it is. No moving git tags or GitHub releases are created any more, only the image tags move.

## Branch model

| Branch | What it is | Who writes to it |
|---|---|---|
| `upstream-main` | Pure mirror of upstream. Never committed to directly, only fast-forwarded (to the release tag being integrated). | the release workflow |
| `feat/aero-migrations` | Fork infrastructure, listed first: the fork's own migration folder `server/src/schema/migrations-aero/` and the composite migration provider that runs it next to upstream's. Every branch that changes the database schema stacks on it (see [Fork migrations](#fork-migrations)). | you, plus the release workflow (rebase only) |
| `feat/*`, `fix/*` | One branch per upstream-PR-able change. Always **rebased** (never merged) onto the current upstream tag, so each stays a clean PR candidate. | you, plus the release workflow (rebase only) |

The branches currently listed, in stacking order:

| Branch | Parent | What it carries |
|---|---|---|
| `feat/aero-migrations` | upstream tag | fork migration folder + composite migration provider |
| `feat/private-mode` | `feat/aero-migrations` | private mode (server, web, mobile), migration `1789200000000-PrivateMode` |
| `feat/private-mode-sync-compat` | `feat/private-mode` | official-client sync compatibility for private assets, migration `1789250000000-PrivateModeSyncCompat` |
| `fix/event-manager-listener-drop` | upstream tag | web event manager fix (also carried inside `feat/private-mode`) |
| `feat/search-back-navigation` | `feat/private-mode` | mobile: open the timeline at a date, keep search results when viewing an asset; stacked because it edits the same timeline widget private mode touches |
| `feat/untagged-filters` | `feat/search-back-navigation` | "No tags" search filter (web, mobile), not-in-album/untagged server tests; stacked because it edits the same search filter files private mode does and its required `hasNoTags` field is passed by the search page tests of private mode and search-back |
| `feat/deleted-hash` | `feat/private-mode-sync-compat` | previously deleted files: remembered checksums, `deletedReimport` preference, migration `1789339001650-AssetDeletedChecksum`; stacked because it shares the user-preferences files with private mode and the sync/open-api files with the compat layer |
| `main` | Disposable integration branch and the repository default: upstream tag + a merge of every branch listed in `.github/aero-branches.txt`, in order, plus one "fork glue" commit (this folder, the workflows, the scripts, the branch list). Rebuilt from scratch by automation. The Docker image is built from it. | the release workflow (and the initial setup) |

Do not develop on `main`. Anything you commit there other than the glue paths (`.github/workflows/aero-release.yml`, `.github/workflows/aero-dry-run.yml`, `.github/workflows/aero-revert-validation.yml`, `.github/scripts/`, `.github/aero-branches.txt`, `docs-aero/`, `scripts/aero/`) is thrown away on the next integration. A change to the glue itself (this file, the workflows, the scripts) needs no release: it is committed to `main` directly and applies to the next run.

Never use GitHub's "Sync fork" button on this repository. It would merge upstream into the integration `main` instead of rebuilding it; the release workflow is the replacement.

### Stacked branches

`.github/aero-branches.txt` lists one branch per line, in stacking order, with an optional parent:

```
feat/aero-migrations
feat/private-mode feat/aero-migrations
feat/private-mode-sync-compat feat/private-mode
fix/event-manager-listener-drop
feat/search-back-navigation feat/private-mode
feat/untagged-filters feat/search-back-navigation
feat/deleted-hash feat/private-mode-sync-compat
```

A branch without a parent is rebased straight onto the upstream tag. A branch with a parent is rebased onto the parent's freshly rebased tip (`git rebase --onto <new parent> <old parent> <branch>`), so a stack survives the rebase as long as the child was already rebased onto the parent's current tip. If the parent gained commits the child does not have yet, rebase the child onto the parent locally first, otherwise the integration stops at the conflict.

## Adding a feature branch

1. Branch from the current upstream tag: `git fetch upstream --no-tags "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z" && git checkout -b feat/my-thing vX.Y.Z` (or from the parent branch if it stacks on one; a branch that adds a migration branches from `feat/aero-migrations`). `upstream-main` points at that tag too.
2. Push it to `origin`.
3. On `main`, append it to `.github/aero-branches.txt` (add the parent as a second column if it stacks), commit, push `main`.
4. The branch is merged in on the next integration. To ship it before the next upstream release, force the current tag: Actions, **Aero release**, Run workflow, `tag` = the current `vX.Y.Z`. That rebuilds `main`, builds a new release candidate and asks for approval again (see below).
5. When the change lands upstream, delete the branch and remove its line.

## Fork migrations

Upstream keeps its migrations in `server/src/schema/migrations/` with an append-only `ORDER` file that CI verifies: a new migration must sort after every existing one. A fork migration carries the timestamp of the day it was written, and upstream keeps adding migrations after that, so after the next rebase the fork file would sit in the middle of upstream's list, kysely's migrator would refuse to boot in production (`corrupted migrations: expected previously executed migration ... at index N`) and every rebase would mean renumbering the file and repairing every installed database.

`feat/aero-migrations` solves this once, the way [Noodle Gallery](https://github.com/open-noodle/gallery) does: fork migrations live in `server/src/schema/migrations-aero/` (its README states the rules), a `CompositeMigrationProvider` (`server/src/utils/migration.ts`) merges both folders for kysely, the migrator runs with `allowUnorderedMigrations: true` so pending fork migrations run whatever upstream appended after them, and `immich-admin schema-check` reads both folders. Upstream's folder and `ORDER` are never touched by a fork branch, so a rebase replaces them wholesale without conflicts, and `scripts/aero/revert-coverage-check.sh` fails if a file ever ends up there.

Rules for a branch that changes the schema:

- stack it on `feat/aero-migrations` (parent column in `.github/aero-branches.txt`),
- put the migration in `server/src/schema/migrations-aero/`, named like upstream's (`<timestamp>-<Name>.ts`); `pnpm run migrations:generate` writes it into upstream's folder and appends `ORDER`, so move the file and restore `ORDER` before committing,
- extend `scripts/aero/revert-to-immich.sql` on `main` and its `kysely_migrations` DELETE (the coverage check tells you).

Migration names are the file names, so an instance migrated before the folder existed sees the same names and nothing runs twice.

## The release flow: `.github/workflows/aero-release.yml`

Runs every 6 hours and on manual dispatch (inputs `tag`, `dry_run`).

```
detect ──new tag──> integrate ──ok──> candidate ──> revert-validation ──ok──> ready ──> [approval] ──> publish
   │                    │                                  │
   └─ nothing new       │                                  └─ broken revert: issue "Upstream <tag>: revert validation failed", release blocked
                        └─ conflict / failing check: issue "Upstream <tag>: integration failed", nothing pushed
```

**`detect`** asks the GitHub API for the latest upstream release (`repos/immich-app/immich/releases/latest`, which never returns prereleases or drafts) and stops, with a log line, when:

- the fork already has a release `<tag>-aero.N` for any `N` (or the historical bare `<tag>-aero`); the fork's releases are the "processed" marker, listed with `gh api repos/<fork>/releases` and matched by prefix in `.github/scripts/aero-revision.sh`, or
- an issue `Upstream <tag>: ready for release` is open (a candidate is built and waiting for your approval).

Dispatching with `tag` skips both checks and forces that tag.

**`integrate`** checks out `main` with the `AERO_SYNC_TOKEN` secret and runs `.github/scripts/aero-integrate.sh integrate <tag commit>`, which, without pushing anything:

1. fetches the tag and checks that `upstream-main` is an ancestor of it (`upstream-main` must never diverge),
2. rebases every listed branch in order onto the tag, stacked ones onto their rebased parent,
3. recreates `main` = tag + `git merge --no-ff` of each branch in order, then re-applies the glue paths from the previous `main` tip as one commit `chore(aero): fork glue (workflows, scripts, branch list, docs)`.

Then it runs the checks on the rebuilt `main` with upstream's own toolchain (mise): server `install`, `plugins`, `check` (tsc), `test --run` (unit tests), then sdk build and web `check-typescript`. Last comes the e2e smoke (`e2e-private-mode`), mirroring upstream's "End-to-End Tests (Server & CLI)" job: the cli and e2e packages are installed, `e2e/docker-compose.yml` is brought up with `--build` (server image built from the rebuilt `main`, plus postgres, valkey and the e2e auth server) and `e2e/src/specs/server/api/private-mode.e2e-spec.ts` runs against it with `VITEST_DISABLE_DOCKER_SETUP=true`. Only the fork's own suite runs here (upstream's full API+CLI suite would roughly double the job); the `AERO_E2E_SPECS` variable in the step widens it. The stack's logs are attached to the run as `aero-e2e-private-mode-logs`.

- **Any conflict or failing check**: the job opens or updates the issue `Upstream <tag>: integration failed` with the branch, the conflicting files (or the failing check with the last 80 log lines) and the exact local commands to fix it, and fails. Nothing is pushed; `upstream-main`, the branches and `main` are untouched.
- **Success**: `aero-integrate.sh push` pushes `upstream-main` (fast-forward to the tag), each rebased branch (`--force-with-lease` against the tip it started from) and `main` (`--force-with-lease`, only when its tree changed), and closes an earlier "integration failed" issue for that tag.

**`candidate`** builds `server/Dockerfile` from the new `main` (context `.`, `linux/amd64`, upstream's build args `DEVICE=cpu`, `BUILD_ID`, `BUILD_IMAGE`, `BUILD_SOURCE_REF`, `BUILD_SOURCE_COMMIT`, layer cache in the Actions cache) and pushes **only** the release-candidate tags to `ghcr.io/aeroverra/immich-server`:

- `<tag>-aero-rc`
- `<tag>-aero-rc-<short sha of main>`

It checks whether `machine-learning/` differs from the upstream tag; when it does (the face attributes models), it also builds `ghcr.io/aeroverra/immich-machine-learning` with the same rc and release tags.

**`revert-validation`** calls the reusable workflow `.github/workflows/aero-revert-validation.yml` with the rc image and the tag (see [Reverting to upstream Immich](#reverting-to-upstream-immich)): a fresh database is migrated by the rc image, `scripts/aero/revert-to-immich.sql` reverts it, upstream `<tag>` has to boot on the result with nothing to migrate and no schema drift. A fork release that cannot be undone is not released.

**`ready`** opens or updates the issue `Upstream <tag>: ready for release` with the upstream release link, the branch tips, the check results, the rc tags, the revision the approval will create ("will publish as `<tag>-aero.N`") and a link to the run whose `publish` job is waiting. If the revert validation failed it instead opens `Upstream <tag>: revert validation failed` with the fix commands and fails, so `publish` never runs for that candidate.

**`publish`** runs in the `release` environment, so it waits for a required reviewer. GitHub emails you a deployment review request; approve it from the email, the issue link or the run page. On approval it:

1. computes the fork revision `N` = 1 + the highest revision among the fork's releases `<tag>-aero.N` (the bare `<tag>-aero` counts as 1; `.github/scripts/aero-revision.sh next <tag>`). It is computed again here, not taken from `ready`, in case another publish of the same tag happened while the run waited; a git tag `<tag>-aero.N` that already exists stops the job,
2. retags the rc image as the immutable `ghcr.io/aeroverra/immich-server:<tag>-aero.N` with `docker buildx imagetools create` (no rebuild, same digest),
3. creates the GitHub release `<tag>-aero.N` on the fork with `gh release create --target <main commit>` (notes: upstream release link, the immutable image tag first and the moving ones after, the fork branch table with the exact commits, checks) with `scripts/aero/revert-to-immich.sql` attached as a release asset. An existing release of that name is never edited: the job fails instead,
4. moves the pointer image tags `<tag>-aero` and `aero` to the new revision,
5. closes the "ready for release" issue with a comment naming the immutable tag to pin at home.

The job exposes `revision` and `release_tag` as outputs. Rejecting the deployment leaves the rc image in place and the issue open, so the 6-hour schedule leaves that tag alone. To get a new candidate later (after fixing a branch, say), close the issue or dispatch with `tag`.

`dry_run` on dispatch runs `detect` and `integrate` (rebase, rebuild, checks) and stops there: no push, no image, no issue.

### Image tags

See the tag table under [Versioning](#versioning): pin `<tag>-aero.N` at home; `<tag>-aero` and `aero` are moving pointers; `<tag>-aero-rc` and `<tag>-aero-rc-<sha>` are candidates you can try before approving.

The machine-learning image is built only when the fork changes `machine-learning/`; the release notes say which ML image to run. Without fork ML changes the family instance keeps upstream's `ghcr.io/immich-app/immich-machine-learning`.

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
    image: ghcr.io/aeroverra/immich-server:v3.2.0-aero.2   # the approved fork release, immutable
    # everything else unchanged

  immich-machine-learning:
    image: ghcr.io/aeroverra/immich-machine-learning:v3.2.1-aero.N   # when the release notes list a fork ML image
    # otherwise upstream's ghcr.io/immich-app/immich-machine-learning at the same version
```

Then on the aero-docker host `docker compose pull immich-server && docker compose up -d immich-server`. Pin the immutable `<tag>-aero.N` (the release notes and the closing comment on the "ready for release" issue name it), not `<tag>-aero` or `aero`: those move on every publish, so a `pull` would silently change what runs. With the pin the instance moves only when you edit the compose file, after you approved the release and read its notes; the ML image should be bumped to the same upstream version at the same time.

The image's upstream version is visible in its tag and in the server's About dialog (`IMMICH_SOURCE_COMMIT` is the `main` commit); the fork revision only in the tag.

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

Forcing a tag that already has a fork release rebuilds the candidate and, on approval, publishes it as the next revision `<tag>-aero.N+1` (new immutable image tag, release and git tag) and moves `<tag>-aero` and `aero` to it. The earlier revision stays as it was.

## Doing it by hand

The workflow is a thin wrapper around `.github/scripts/aero-integrate.sh`, which also runs locally from a clone whose `origin` is the fork:

```bash
git fetch upstream --no-tags "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"
bash .github/scripts/aero-integrate.sh integrate vX.Y.Z /tmp/aero-state   # rebase + rebuild main, no push
# run the checks on the rebuilt main, then
bash .github/scripts/aero-integrate.sh push /tmp/aero-state
```

Exit code 2 means a rebase/merge conflict (details in `/tmp/aero-state/result.env` and `conflict-files.txt`). The image build and the release are only done by the workflow.

## Reverting to upstream Immich

The fork image adds three database migrations (`1789200000000-PrivateMode`, `1789250000000-PrivateModeSyncCompat`, `1789339001650-AssetDeletedChecksum`, all in `server/src/schema/migrations-aero/`). An upstream image refuses to boot on a database that has migrations it does not know about:

```
Migration "1789200000000-PrivateMode" was already applied to this database but is not in this version of Immich
```

`scripts/aero/revert-to-immich.sql` undoes exactly those three migrations, so the container can be pointed back at upstream. The same file is attached to every fork release (`<tag>-aero.N`, asset `revert-to-immich.sql`), and every release candidate is validated with it before it can be published (see `revert-validation` above).

**What is lost** (there is no undo other than a database backup):

- the private flag of every asset and every album (`asset.isPrivate`, `album.isPrivate`): everything becomes visible again to its owner and to whoever it is shared with,
- the private-mode state of every session (`session.privateModeExpiresAt`); sessions stay, nobody is logged out,
- the `privateMode` block of each user's preferences (timeout, sidebar entry, include-in-memories),
- the remembered checksums of permanently deleted assets (table `asset_deleted_checksum`): a re-upload of a previously deleted file is treated like any other upload afterwards; a "Previously deleted" album, if one was created, stays as an ordinary album,
- the `deletedReimport` block of each user's preferences (mode, album id).

Nothing else is touched: photos, videos, albums, people, sharing, users, API keys and the library on disk stay as they are. The script only drops the three columns, the partial index, the three trigger functions with their triggers, the `asset_deleted_checksum` table, the seven `migration_overrides` rows and the three `kysely_migrations` rows the fork migrations created, and it verifies that nothing is left before committing. It is transactional (a failure rolls everything back) and idempotent (safe to run twice).

**Steps** (on the aero-docker host, in the compose directory; adjust `-U`/`-d` to `DB_USERNAME`/`DB_DATABASE_NAME` from `.env`):

```bash
docker compose stop immich-server                                           # 1. the script locks asset/album/session
docker compose exec database pg_dump -U postgres -d immich > aero-pre-revert-$(date +%F).sql   # 2. the way back
docker compose cp scripts/aero/revert-to-immich.sql database:/tmp/          # 3. (or the release asset)
docker compose exec database psql -U postgres -d immich -v ON_ERROR_STOP=1 \
  -c "SET aero.revert_token = 'i_accept_data_loss';" \
  -f /tmp/revert-to-immich.sql
```

The `SET aero.revert_token` is the acknowledgement; without it the script refuses to run and changes nothing. Then in `docker-compose.yml` set the server image to upstream at the **same** version the fork image was built from (the fork tag says which: `v3.2.0-aero.2` was built from `v3.2.0`):

```yaml
    image: ghcr.io/immich-app/immich-server:v3.2.0
```

and `docker compose up -d immich-server`. The log must show `Finished running migrations` with no `Migration "..." succeeded` lines and `No schema drift detected`; `docker compose exec immich-server immich-admin schema-check` prints `Migrations are up to date` and `No schema drift detected`. A newer upstream version works too (it just runs its own newer migrations); an older one does not, Immich never downgrades. The machine-learning image is untouched by all of this.

Going back to the fork later is just switching the image again: the fork migrations run once more and everything starts out public.

### Validating the revert script

`.github/workflows/aero-revert-validation.yml` runs for every release candidate and can be dispatched by hand (Actions, **Aero revert validation**, inputs `fork_image` and `upstream_tag`). It is two scripts, both also runnable locally with Docker:

```bash
git fetch upstream --no-tags "+refs/tags/v3.2.0:refs/tags/v3.2.0"
bash scripts/aero/revert-coverage-check.sh v3.2.0           # every file in migrations-aero is in the script's DELETE, nothing upstream is, upstream's folder is pristine
bash scripts/aero/revert-validate.sh ghcr.io/aeroverra/immich-server:v3.2.0-aero.2 v3.2.0
```

`revert-validate.sh` starts a throwaway postgres and valkey on a private docker network (`PG_PORT=55440` also publishes postgres on localhost), boots the fork image until it has migrated, seeds a user with both fork preference blocks and one remembered checksum, stops it, runs the script (once without the token, which must be refused; once with it; once more, which must be a no-op), then boots the upstream image on the same database and asserts `Finished running migrations` with nothing executed, `No schema drift detected`, a clean `immich-admin schema-check`, no `isPrivate` column in `\d asset` and no `asset_deleted_checksum` table in `\dt`. Everything it created is removed on exit. When a new fork migration lands, the coverage check fails until the SQL is extended, and the runtime check fails until the SQL actually drops what the migration created.
