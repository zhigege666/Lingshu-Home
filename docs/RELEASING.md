# Versioning, builds and releases

Lingshu-Home uses `VERSION` as the only manually maintained product version. It follows SemVer. `scripts/dev.py build` derives the frontend package version from it; the server and UI read the product version separately from the `/api/v1` and page-schema versions.

## Development changes

Each change set updates `CHANGELOG.md` under `Unreleased` and the relevant public README or `docs/` file. Keep the English and Chinese README aligned. Version bumps are not required for each edit; they happen when preparing a release.

Pull requests and pushes to `main` run application CI. Ordinary application changes do not create a release or publish an image. Changes to the latest-promotion workflow, script or its tests also run the alias-maintenance workflow described below; that workflow reuses an already published stable image.

## Preparing an authorized release

1. Complete implementation, review, application tests and documentation, including any migration/recovery instructions.
2. Set the intended SemVer in `VERSION`. Update **both `README.md` and `README.zh-CN.md` in every release**, keeping the current version, download/source links, exact-image example, feature scope and upgrade/recovery instructions aligned. Add a non-empty dated changelog section in the form `## [VERSION] - YYYY-MM-DD`; keep `Unreleased` first. The GitHub Release notes are generated from that same section.
3. Review and commit the intended public files. Private design material, credentials, runtime databases and generated application output are excluded.
4. Once release publication is authorized, create and push `v<VERSION>` pointing at that reviewed commit.

Creating or pushing a tag is a publishing decision. It is not part of an ordinary development build. The first application release uses `VERSION=0.0.1`, the dated `0.0.1` changelog entry and the matching `v0.0.1` tag. Earlier `0.1.0-dev.1` references identify development evidence, not a previously published application version.

## Automated gates

The release workflow calls the same CI used for the application:

- Repository/version/changelog checks, including both READMEs containing the current version and both READMEs plus CHANGELOG changing since the preceding ancestor release tag; Python release/launcher tests and script syntax.
- Frontend and Go builds with original dependency notices.
- SQLite and PostgreSQL permission, navigation, data-source, push and MCP tests.
- Complete HTTP acceptance against fresh databases, plus actual process-restart persistence checks.
- A Docker image build and a disposable runtime/volume/restart check.

The `acceptance-summaries` workflow artifact retains only the four credential-free `summary.json` files for SQLite HTTP, PostgreSQL HTTP, storage-process and storage-container acceptance. The upload explicitly allows those files beneath the hidden `.runtime` directory; databases, environment files, local keys and private test configuration are not part of the upload. Inspect the artifact together with the job logs when checking the upgrade gates. An early test failure can leave a partial set or no summaries; the successful upload step alone is not proof that every test ran.

The release-documentation regressions create disposable local Git repositories and shallow clones. Their Git helper sets `maintenance.auto=false`, `gc.auto=0`, `maintenance.autoDetach=false` and `gc.autoDetach=false` on each command, so automatic maintenance cannot outlive a fixture. Command-level settings also cover clone operations without relying on the source repository's local configuration. They do not alter the host's Git configuration. Temporary-directory cleanup remains strict: an unsuccessful cleanup still fails the test. These settings follow Git's [command-level configuration](https://git-scm.com/docs/git#Documentation/git.txt--cltnamegtltvaluegt) and [maintenance/garbage-collection configuration](https://git-scm.com/docs/git-config).

Main CI run [40200304828](https://github.com/zhigege666/Lingshu-Home/actions/runs/40200304828) reported `Directory not empty: 'objects'` while cleaning a release-documentation fixture after its test body, while the application and Docker gates passed. The log did not identify the concurrent writer; this fixture isolation addresses automatic detached Git maintenance as a plausible source without claiming that the original background process was proven. A successful local repeat does not replace the hosted release gates.

After this isolation change, the 17 release-documentation tests passed 20 consecutive local runs (340 test executions), and all 68 Python regressions passed once on Git 2.51.1 and Python 3.12.14. The failing hosted run used Git 2.55.0; hosted validation of the corrected commit remains a separate requirement.

Packaging then requires a clean checkout, an existing matching local tag, and a matching dated changelog entry. It uses `git archive` of that exact commit to prepare an isolated build. Untracked files from a developer's working directory are never selected.

One Linux amd64 Docker image is built and exercised. The Linux program, built frontend and license directory are extracted from the same image. The standalone bundle is then run with its default relative paths; the check verifies version, exact served frontend bytes, initialization and data after a real restart.

## Artifacts produced by a successful release

| Artifact | Contents |
| --- | --- |
| Linux amd64 archive | Static Go server, built `web/dist`, `VERSION`, original project/dependency notices and run instructions |
| Source `.tar.gz` and `.zip` | The exact reviewed public source snapshot |
| Docker image archive | `docker save` of the image already used for validation |
| `release-notes.md` | The matching dated CHANGELOG entry, artifact/platform identity and source commit |
| `release-metadata.json` | Version, tag, commit, image identity and the complete artifact list |
| `SHA256SUMS` | Hashes for every transferred release artifact except the checksum manifest itself |

The registry coordinate is `ghcr.io/<lowercase owner>/<lowercase repository>:<full version>`. Version `0.0.8` uses `ghcr.io/zhigege666/lingshu-home:0.0.8`. A prepared coordinate is not evidence of successful publication; check the matching release run and verify the actual image before announcing availability.

The application publisher pushes immutable exact version tags. After a stable GitHub Release is successfully published, a separate promotion job synchronizes `latest` to the highest published stable SemVer version. Drafts and prereleases are excluded. SemVer build metadata `+` is represented as `_` in the Docker tag because Docker tags cannot include `+`; release metadata retains the original SemVer. Multiple highest stable releases with equal SemVer precedence but different build metadata are ambiguous and stop promotion for maintainer review.

Windows/macOS native clients and additional CPU architectures require their own actual build, install, upgrade and platform checks before being added to the release matrix. A browser interface or cross-compiled server alone is not a validated desktop client.

## Integrity and privacy boundaries

The packager validates allowed source roots and archive paths, rejects links and unsafe paths, and excludes `design`, `.runtime`, `.env*`, user data, key files, database files and generated dependency/build directories. The runtime image explicitly copies public build inputs and outputs. Git ignore rules alone are not the release boundary.

The public `examples/` tree is included in source archives, including the dashboard handoff index and producer samples. The public Unraid `templates/` tree and `ca_profile.xml` are also included. All remain subject to the same private-path, key, database, generated-output and link exclusions; allowing a source root does not permit secrets or generated files beneath it.

Source validation also rejects old frontend build backups directly under `web/dist.*`, such as `web/dist.compose-previous`. These are generated outputs, not source inputs. This restriction does not reject ordinary source modules such as `web/src/dist.ts` or remove any existing backup directory from the working checkout.

The publish job downloads the tested artifacts from the same workflow run. Before pushing it verifies the complete hash set, source commit, tag, expected version and the ID/OS/architecture of the loaded image. It does not rebuild the image in the publish job.

Downloads are first uploaded to a draft GitHub Release. The workflow pushes the exact tested image and publishes the GitHub Release only after that succeeds. The remote tag's commit is checked again before final publication.

GitHub Releases and GHCR are separate services, so publication across them cannot be atomic. A failure can leave an unpublished draft or an image already pushed. Inspect those recorded artifacts before retrying. Existing releases and drafts are not silently overwritten or deleted by the workflow. If only latest promotion fails, the exact-version release remains available; repair the alias separately rather than rerunning the application publisher against that existing release.

## Stable latest alias and repair

`.github/workflows/promote-latest.yml` has three entry points: a reusable call after successful stable publication, **Actions → Promote stable image to latest → Run workflow** on `main`, and a `main` push limited to that workflow, `scripts/promote_latest.py`, or `tests/test_promote_latest.py`. The maintenance-push entry point bootstraps or repairs the alias when promotion code changes; it never builds development source or creates a Release.

All entry points use the same fixed job concurrency group. Within that lock the job runs the promotion regressions, reads all published Releases and selects the highest numeric stable SemVer. An old release rerun therefore cannot choose an older version merely because it triggered the job. The script checks the published metadata checksum, tag commit, exact image coordinate, config digest, OCI source/version/revision labels and Linux amd64 platform. Registry reads use anonymous pull access. Only an explicit `latest` manifest 404 permits initial creation; authorization or server errors fail the job.

The alias is copied from the verified manifest digest with `docker buildx imagetools create --prefer-index=false`, preserving the single-platform manifest. No image is rebuilt and no exact tag or Release asset is replaced. An existing `latest` must already match a recognized published stable image; an unknown image or changed source stops promotion. After writing, both `latest` and the exact source tag are read back and must still match the verified manifest and config digests. An already matching alias is a successful no-op.

For an authenticated repair, use the manual workflow on `main`; its repository `GITHUB_TOKEN` receives `contents: read` and `packages: write`. No personal token needs to be added to repository secrets. A read-only public preflight is available locally:

```bash
python3 scripts/promote_latest.py --repository zhigege666/Lingshu-Home
```

That command makes no registry writes. `--apply` additionally requires Docker Buildx, a registry login and the shared workflow lock; use the workflow for publication. After a successful repair, verify an anonymous `docker pull ghcr.io/zhigege666/lingshu-home:latest` and compare its digest with the exact release tag. Changing this alias does not update installed containers. Existing Unraid installations on a fixed tag need a one-time Repository change, then normal pull/recreate updates; follow the [Unraid upgrade guide](UNRAID.md).

## Published-release availability check

After the tagged workflow completes, read back the published release, exact tag commit and all seven expected assets. Download the actual files, verify `SHA256SUMS`, and check that `release-metadata.json` identifies the same version, source commit and tested image. Verify the Linux archive's documented extraction/start commands against fresh data and a real restart.

For a new GHCR package, explicitly verify its public visibility. A successful authenticated push does not prove that a new user can pull it. Use a fresh Docker client configuration with no registry credentials to pull the exact version and compare its image identity with release metadata. GitHub's [package visibility documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility) describes the package setting; repository visibility alone is not this check.

If a publish attempt leaves a draft, first compare its target commit, asset set and checksums with that attempt's verified artifacts. Preserve already published tags and releases. Resume only the unfinished, identity-verified steps; do not delete an existing draft or rebuild a different image merely to make a retry pass.

## Local commands

For repository metadata and offline package-boundary checks:

```bash
python3 scripts/check_repository.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The Python discovery command includes the release packager, latest-promotion and Linux development-launcher regressions. Promotion tests use offline fixtures and never authenticate or write to a registry; an actual successful workflow and anonymous registry read-back remain separate publication evidence. The launcher tests need Linux process inspection, a local `sleep` executable and permission to bind temporary loopback ports. They cover executable replacement, immediate restart after TCP TIME_WAIT and refusal of an active listening port; a skip on an unsupported platform is not Linux runtime verification.

Application packaging requires a native Linux amd64 host, Docker, Git and Python 3.10+. Go and Node builds run inside the pinned Docker build stages. Only after creating a clean, matching authorized tag, run from the repository root:

```bash
release_tag="v$(cat VERSION)"
python3 scripts/build_app_release.py --tag "$release_tag" --output dist/release
cd dist/release
sha256sum --check SHA256SUMS
```

The packaging command builds and validates files locally; it does not authenticate to a registry, push an image or create a GitHub Release. Online publication is a separate workflow stage.

## Version 0.0.4 upgrade and evidence

The `v0.0.3` attempt failed its Go race-detector fixture check before packaging or publication. Its tag and failed run remain unchanged. Version 0.0.4 corrects the fixture lifetime and publishes the complete feature set under a new tag; no 0.0.3 Release or registry image is claimed.

Version 0.0.4 includes 120 category icons, atomic batch deletion, button-side confirmations, scoped LAN/custom-port icon and template fetching, bounded modal scrolling, account-local startup-space preferences and eight navigation/favorites content settings. It retains the stable `latest` promotion already merged into `main` and adds mandatory bilingual README/release-note checks.

There is no new database migration or page schema bump from 0.0.2. Retain the database, provider configuration and instance keys, and back up before upgrading. Older validators do not accept the new component fields or icon IDs; after using them, roll back with the pre-upgrade database/key backup rather than assuming an old executable can preserve them. A direct upgrade from 0.0.1 still follows migration 007 and its original-language requirements below.

The bilingual development browser evidence is retained in the test guide with its actual 0.0.2 working-tree build identity. The release adds repository/documentation checks and uses the tagged hosted CI, same-image packaging and public-download/registry read-back described above. Development tests are not relabeled as checks of a published 0.0.4 artifact.

## Version 0.0.2 upgrade and evidence

Version 0.0.2 includes the navigation batch/draft-history work, one-time instance language, shared form spacing and source-format examples. It also updates the pinned Unraid image and includes the public Unraid metadata in source archives. The matching dated changelog defines the release scope; all seven artifacts and the registry image still require the complete tagged workflow above.

Migration `007_instance_language.sql` fixes the language for each database. Back up the database and matching instance keys before upgrading. An existing English 0.0.1 deployment must retain its `en` startup configuration on its first 0.0.2 startup. Once saved, the database language wins over later startup configuration. Rolling back to 0.0.1 requires the pre-upgrade database/key backup; replacing only the executable or image cannot downgrade the migrated database. See [storage and recovery](STORAGE.md).

The full 2026-10-24 working-tree browser and dual-database evidence, final-version Docker checks, exact source correspondence and remaining release boundaries are recorded in [the test guide](../tests/README.md). Pre-release deployment checks and published-download verification are separate evidence: a local image is not proof that the final GHCR tag or GitHub assets are available. Published identity remains the exact tag commit, successful release workflow, actual downloads and `release-metadata.json`.

## Development verification and release boundary

The latest network, template, dashboard and pre-release verification is recorded in [the current test-guide section](../tests/README.md#当前轮次网络模板预置与空闲验收) and [the performance report](PERFORMANCE.md). Each record identifies its actual build and execution scope; a working-tree candidate does not satisfy the clean-tag or hosted-CI gates.

The 2026-10-19 final working-tree candidate includes the PostgreSQL request-cancellation and HTTP shutdown corrections. Its complete race run passed **97 top-level tests with all five dedicated PostgreSQL test databases enabled and no skips**. Python discovery passed **17 tests, including 12 packaging regressions**. The new Docker image passed container/volume/restart checks; its actual extracted Linux binary and frontend passed the original standalone-bundle helper and both full HTTP wrappers. SQLite and PostgreSQL each passed **2,229 assertions across four exercise/restart phases**, for **4,458 combined**. Exact image/binary/archive hashes, timings, original-notice coverage and the retained initial failed run are in the test guide. This local candidate was not created by bypassing the clean-tag release builder and has no official release metadata or published image identity.

The counts in the following two paragraphs describe the recovery verification **before the subsequent admin, homepage and category-navigation UI refinement**. They are retained as historical evidence, not reported as a rerun of the latest interface. The subsequent historical interface checks remain in [their own test-guide section](../tests/README.md#本轮界面改版验收).

The `0.1.0-dev.1` development implementation was checked on 2026-10-18. SQLite and PostgreSQL each completed all four HTTP exercise/restart phases: **18 groups and 2,225 assertions per provider, 36 groups and 4,450 assertions combined**. The PostgreSQL-enabled complete Go suite passed. The Docker image was built and its health, initialization, static frontend, non-root user and restart-persistence checks passed. The Go notice collector passed for **24/24 modules** on nx11, including its verified original-license fallback. The 11 Python release-boundary tests and the separate Linux launcher regression also passed.

Independent Chromium runs at 2560 × 1440 passed the CRUD, bookmark-import and layout phases, totaling **146 phase assertions excluding repeated preflight checks**. A separate six-viewport run passed 63 assertions including its preflight, and a separate search/favorite/mouse interaction run passed 155 including its preflight. The latter verified actual resize, drag, save, reload and restoration of the original complete grid configuration, as well as the corrected admin Tabs geometry. These browser counts have different preflight boundaries and are recorded separately from the 4,450 Python HTTP assertions.

These are historical development verification results. The 2026-10-19 working-tree checks did not execute a complete clean-tag application release build or publish a GitHub Release or registry image. Release `0.0.1` is assessed separately through its tagged Actions run, downloaded artifacts and public availability checks. Provider counts, browser phase results, execution boundaries and runnable test commands are maintained in [the test guide](../tests/README.md); they do not establish Windows/macOS client verification or a real GitHub Traffic baseline.


## Version 0.0.5 upgrade and evidence

Version 0.0.5 includes the file-backed Markdown library, bookmark usage context, scoped document HTTP/MCP tools and optional direct HTTPS. SQLite and PostgreSQL each apply additive migration 008 on startup. Preserve the existing data directory, database, instance keys, language, ports and access mode; absent new settings, document roots remain `[]` and direct TLS remains disabled. An existing reverse proxy can keep terminating HTTPS.

The Unraid catalog template keeps `latest`, its original appdata mapping and HTTP WebUI as defaults. Advanced document-root and certificate/key variables are opt-in. Installed containers retain saved templates; enabling the library requires explicit document Path mappings plus the allowlist and an Owner's space binding. Enabling direct TLS additionally requires a separate read-only certificate mount, both TLS variables and an HTTPS WebUI URL. Do not automatically add empty document/certificate Paths or expose broad filesystem roots.

Back up the complete appdata/database and matching keys before upgrading. Once document roots are used, include recovery history and original document/attachment directories. Returning to 0.0.4 requires its pre-upgrade database/data backup and old image; changing only the image tag does not roll back schema 008 or external file edits.

The release must retain the application CI, both database providers, HTTP restart acceptance and exact-image packaging gates. The container checks additionally exercise an isolated 0.0.4-to-candidate upgrade and the candidate's mounted Markdown/direct-TLS behavior. Read the actual hosted run and its tested image identity before describing those checks as passed. NAS-specific encryption, kernel I/O behavior and the user's existing deployment remain separate deployment verification.

The consecutive container suites reuse their loopback port. The preflight permits TCP `TIME_WAIT` from the stopped preceding container while still rejecting a live listener, with socket regressions for both boundaries. An actual port conflict remains a test failure; do not bypass it or connect to the process already using that port.
