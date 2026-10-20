# Versioning, builds and releases

Lingshu-Home uses `VERSION` as the only manually maintained product version. It follows SemVer. `scripts/dev.py build` derives the frontend package version from it; the server and UI read the product version separately from the `/api/v1` and page-schema versions.

## Development changes

Each change set updates `CHANGELOG.md` under `Unreleased` and the relevant public README or `docs/` file. Keep the English and Chinese README aligned. Version bumps are not required for each edit; they happen when preparing a release.

Pull requests and pushes to `main` run application CI. These events validate code; they do not create a release or publish an image.

## Preparing an authorized release

1. Complete implementation, review, application tests and documentation, including any migration/recovery instructions.
2. Set the intended SemVer in `VERSION`. Add a non-empty dated changelog section in the form `## [VERSION] - YYYY-MM-DD`; keep `Unreleased` first.
3. Review and commit the intended public files. Private design material, credentials, runtime databases and generated application output are excluded.
4. Once release publication is authorized, create and push `v<VERSION>` pointing at that reviewed commit.

Creating or pushing a tag is a publishing decision. It is not part of an ordinary development build. The first application release uses `VERSION=0.0.1`, the dated `0.0.1` changelog entry and the matching `v0.0.1` tag. Earlier `0.1.0-dev.1` references identify development evidence, not a previously published application version.

## Automated gates

The release workflow calls the same CI used for the application:

- Repository/version/changelog checks, Python release/launcher tests, and script syntax.
- Frontend and Go builds with original dependency notices.
- SQLite and PostgreSQL permission, navigation, data-source, push and MCP tests.
- Complete HTTP acceptance against fresh databases, plus actual process-restart persistence checks.
- A Docker image build and a disposable runtime/volume/restart check.

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

The registry coordinate is `ghcr.io/<lowercase owner>/<lowercase repository>:<full version>`. Version `0.0.1` uses `ghcr.io/zhigege666/lingshu-home:0.0.1`. A prepared coordinate is not evidence of successful publication; check the matching release run and verify the actual image before announcing availability.

Only exact version tags are pushed; there is no floating `latest` tag. SemVer build metadata `+` is represented as `_` in the Docker tag because Docker tags cannot include `+`. Release metadata retains the original SemVer.

Windows/macOS native clients and additional CPU architectures require their own actual build, install, upgrade and platform checks before being added to the release matrix. A browser interface or cross-compiled server alone is not a validated desktop client.

## Integrity and privacy boundaries

The packager validates allowed source roots and archive paths, rejects links and unsafe paths, and excludes `design`, `.runtime`, `.env*`, user data, key files, database files and generated dependency/build directories. The runtime image explicitly copies public build inputs and outputs. Git ignore rules alone are not the release boundary.

The public `examples/` tree is included in source archives, including the dashboard handoff index and producer samples. Its contents remain subject to the same private-path, key, database, generated-output and link exclusions.

Source validation also rejects old frontend build backups directly under `web/dist.*`, such as `web/dist.compose-previous`. These are generated outputs, not source inputs. This restriction does not reject ordinary source modules such as `web/src/dist.ts` or remove any existing backup directory from the working checkout.

The publish job downloads the tested artifacts from the same workflow run. Before pushing it verifies the complete hash set, source commit, tag, expected version and the ID/OS/architecture of the loaded image. It does not rebuild the image in the publish job.

Downloads are first uploaded to a draft GitHub Release. The workflow pushes the exact tested image and publishes the GitHub Release only after that succeeds. The remote tag's commit is checked again before final publication.

GitHub Releases and GHCR are separate services, so publication across them cannot be atomic. A failure can leave an unpublished draft or an image already pushed. Inspect those recorded artifacts before retrying. Existing releases and drafts are not silently overwritten or deleted by the workflow.

## First-release availability check

After the tagged workflow completes, read back the published release, exact tag commit and all seven expected assets. Download the actual files, verify `SHA256SUMS`, and check that `release-metadata.json` identifies the same version, source commit and tested image. Verify the Linux archive's documented extraction/start commands against fresh data and a real restart.

For a new GHCR package, explicitly verify its public visibility. A successful authenticated push does not prove that a new user can pull it. Use a fresh Docker client configuration with no registry credentials to pull the exact version and compare its image identity with release metadata. GitHub's [package visibility documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility) describes the package setting; repository visibility alone is not this check.

If a publish attempt leaves a draft, first compare its target commit, asset set and checksums with that attempt's verified artifacts. Preserve already published tags and releases. Resume only the unfinished, identity-verified steps; do not delete an existing draft or rebuild a different image merely to make a retry pass.

## Local commands

For repository metadata and offline package-boundary checks:

```bash
python3 scripts/check_repository.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The Python discovery command includes both the release packager and Linux development-launcher regressions. The launcher tests need Linux process inspection, a local `sleep` executable and permission to bind temporary loopback ports. They cover executable replacement, immediate restart after TCP TIME_WAIT and refusal of an active listening port; a skip on an unsupported platform is not Linux runtime verification.

Application packaging requires a native Linux amd64 host, Docker, Git and Python 3.10+. Go and Node builds run inside the pinned Docker build stages. Only after creating a clean, matching authorized tag, run from the repository root:

```bash
release_tag="v$(cat VERSION)"
python3 scripts/build_app_release.py --tag "$release_tag" --output dist/release
cd dist/release
sha256sum --check SHA256SUMS
```

The packaging command builds and validates files locally; it does not authenticate to a registry, push an image or create a GitHub Release. Online publication is a separate workflow stage.

## Development verification and release boundary

The latest network, template, dashboard and pre-release verification is recorded in [the current test-guide section](../tests/README.md#当前轮次网络模板预置与空闲验收) and [the performance report](PERFORMANCE.md). Each record identifies its actual build and execution scope; a working-tree candidate does not satisfy the clean-tag or hosted-CI gates.

The 2026-10-19 final working-tree candidate includes the PostgreSQL request-cancellation and HTTP shutdown corrections. Its complete race run passed **97 top-level tests with all five dedicated PostgreSQL test databases enabled and no skips**. Python discovery passed **17 tests, including 12 packaging regressions**. The new Docker image passed container/volume/restart checks; its actual extracted Linux binary and frontend passed the original standalone-bundle helper and both full HTTP wrappers. SQLite and PostgreSQL each passed **2,229 assertions across four exercise/restart phases**, for **4,458 combined**. Exact image/binary/archive hashes, timings, original-notice coverage and the retained initial failed run are in the test guide. This local candidate was not created by bypassing the clean-tag release builder and has no official release metadata or published image identity.

The counts in the following two paragraphs describe the recovery verification **before the subsequent admin, homepage and category-navigation UI refinement**. They are retained as historical evidence, not reported as a rerun of the latest interface. The subsequent historical interface checks remain in [their own test-guide section](../tests/README.md#本轮界面改版验收).

The `0.1.0-dev.1` development implementation was checked on 2026-10-18. SQLite and PostgreSQL each completed all four HTTP exercise/restart phases: **18 groups and 2,225 assertions per provider, 36 groups and 4,450 assertions combined**. The PostgreSQL-enabled complete Go suite passed. The Docker image was built and its health, initialization, static frontend, non-root user and restart-persistence checks passed. The Go notice collector passed for **24/24 modules** on nx11, including its verified original-license fallback. The 11 Python release-boundary tests and the separate Linux launcher regression also passed.

Independent Chromium runs at 2560 × 1440 passed the CRUD, bookmark-import and layout phases, totaling **146 phase assertions excluding repeated preflight checks**. A separate six-viewport run passed 63 assertions including its preflight, and a separate search/favorite/mouse interaction run passed 155 including its preflight. The latter verified actual resize, drag, save, reload and restoration of the original complete grid configuration, as well as the corrected admin Tabs geometry. These browser counts have different preflight boundaries and are recorded separately from the 4,450 Python HTTP assertions.

These are historical development verification results. The 2026-10-19 working-tree checks did not execute a complete clean-tag application release build or publish a GitHub Release or registry image. Release `0.0.1` is assessed separately through its tagged Actions run, downloaded artifacts and public availability checks. Provider counts, browser phase results, execution boundaries and runnable test commands are maintained in [the test guide](../tests/README.md); they do not establish Windows/macOS client verification or a real GitHub Traffic baseline.
