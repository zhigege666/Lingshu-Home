"""Offline regressions for release boundaries; never create Git tags or publish."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_app_release as release
import check_repository


class ReleasePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lingshu-release-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, name, content=b"public fixture\n", mode=0o644):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)
        return path

    def test_public_archives_preserve_expected_content_and_executable_mode(self):
        source = self.root / "source"
        source.mkdir()
        (source / "README.md").write_text("Public navigation project\n")
        (source / "scripts").mkdir()
        (source / "scripts/run.sh").write_text("#!/bin/sh\nexit 0\n")
        (source / "scripts/run.sh").chmod(0o755)
        first, second, zipped = (self.root / name for name in ("one.tar.gz", "two.tar.gz", "source.zip"))
        for target in (first, second, zipped):
            release.archive_tree(source, target, "Lingshu-Home-1.2.3/", 1700000000, source=True)
        self.assertEqual(first.read_bytes(), second.read_bytes(), "same source tar must not acquire wall-clock gzip metadata")
        expected = {"Lingshu-Home-1.2.3/README.md", "Lingshu-Home-1.2.3/scripts/run.sh"}
        with tarfile.open(first) as archive:
            self.assertEqual(set(archive.getnames()), expected)
            self.assertEqual(archive.extractfile("Lingshu-Home-1.2.3/README.md").read(), b"Public navigation project\n")
            run = archive.getmember("Lingshu-Home-1.2.3/scripts/run.sh")
            self.assertEqual((run.mode, run.uid, run.gid, run.mtime), (0o755, 0, 0, 1700000000))
        with zipfile.ZipFile(zipped) as archive:
            self.assertEqual(set(archive.namelist()), expected)
            self.assertEqual(archive.getinfo("Lingshu-Home-1.2.3/scripts/run.sh").external_attr >> 16, 0o100755)

    def test_real_dashboard_examples_survive_source_extraction_and_both_archives(self):
        examples = Path(__file__).resolve().parents[1] / "examples/dashboard-data"
        index = json.loads((examples / "index.json").read_text("utf-8"))
        sample_names = [example["file"] for contract in index["contracts"] for example in contract["examples"]]
        self.assertEqual(len(sample_names), 8, "the current producer handoff has eight complete push samples")
        self.assertEqual(len(set(sample_names)), len(sample_names))
        self.assertEqual(set(sample_names), {path.name for path in examples.glob("*.push.json")})
        payloads = {}
        for name in ["README.md", "index.json", *sample_names]:
            self.assertEqual(Path(name).name, name, "the handoff index must name local regular files")
            original = examples / name
            self.assertTrue(original.is_file() and not original.is_symlink())
            payloads["examples/dashboard-data/" + name] = original.read_bytes()

        # Exercise the same archive-entry validation as a future git archive,
        # without creating a Git repository, commit or tag for these fixtures.
        raw_archive = self.root / "public-source-input.tar"
        with tarfile.open(raw_archive, "w") as archive:
            for name, body in payloads.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(body)
                archive.addfile(entry, io.BytesIO(body))
        extracted = self.root / "extracted"
        extracted.mkdir()
        release.extract_source(raw_archive, extracted)
        for name, body in payloads.items():
            self.assertEqual((extracted / name).read_bytes(), body)

        prefix = "Lingshu-Home-1.2.3/"
        expected = {prefix + name: body for name, body in payloads.items()}
        tar_path, zip_path = self.root / "public-source.tar.gz", self.root / "public-source.zip"
        release.archive_tree(extracted, tar_path, prefix, 1700000000, source=True)
        release.archive_tree(extracted, zip_path, prefix, 1700000000, source=True)
        with tarfile.open(tar_path) as archive:
            self.assertEqual(set(archive.getnames()), set(expected))
            for name, body in expected.items():
                self.assertEqual(archive.extractfile(name).read(), body)
        with zipfile.ZipFile(zip_path) as archive:
            self.assertEqual(set(archive.namelist()), set(expected))
            for name, body in expected.items():
                self.assertEqual(archive.read(name), body)

    def test_real_unraid_templates_survive_source_extraction_and_both_archives(self):
        repository = Path(__file__).resolve().parents[1]
        payloads = {}
        for name in ("ca_profile.xml", "templates/lingshu-home.xml"):
            original = repository / name
            self.assertTrue(original.is_file() and not original.is_symlink())
            payloads[name] = original.read_bytes()
            self.assertTrue(payloads[name], "public Unraid templates must not be empty")

        raw_archive = self.root / "unraid-source-input.tar"
        with tarfile.open(raw_archive, "w") as archive:
            for name, body in payloads.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(body)
                archive.addfile(entry, io.BytesIO(body))
        extracted = self.root / "extracted"
        extracted.mkdir()
        release.extract_source(raw_archive, extracted)
        for name, body in payloads.items():
            self.assertEqual((extracted / name).read_bytes(), body)

        prefix = "Lingshu-Home-1.2.3/"
        expected = {prefix + name: body for name, body in payloads.items()}
        tar_path, zip_path = self.root / "unraid-source.tar.gz", self.root / "unraid-source.zip"
        release.archive_tree(extracted, tar_path, prefix, 1700000000, source=True)
        release.archive_tree(extracted, zip_path, prefix, 1700000000, source=True)
        with tarfile.open(tar_path) as archive:
            self.assertEqual(set(archive.getnames()), set(expected))
            for name, body in expected.items():
                self.assertEqual(archive.extractfile(name).read(), body)
        with zipfile.ZipFile(zip_path) as archive:
            self.assertEqual(set(archive.namelist()), set(expected))
            for name, body in expected.items():
                self.assertEqual(archive.read(name), body)

    def test_private_generated_and_unreviewed_source_paths_are_rejected(self):
        forbidden = [".", "", "design/architecture.md", ".runtime/secret.json", "data/home.db", ".env", ".env.example",
                     "web/.env.production", "docs/../design/secret.md", "/etc/passwd", "server\\private.go",
                     "server/node_modules/example/LICENSE", "server/key.key", "web/dist/index.html",
                     "web/dist.compose-previous/index.html", "web/dist.previous",
                     "credentials.json", "docs/line\nbreak.md", "docs/./README.md", "docs//README.md",
                     "examples/design/private.md", "examples/.runtime/report.json", "examples/dashboard-data/data/private.json",
                     "examples/dashboard-data/.env.local", "examples/dashboard-data/integrations.key",
                     "examples/dashboard-data/home.sqlite3", "examples/dashboard-data/dist/index.json",
                     "templates/.env", "templates/.env.local", "templates/design/private.xml",
                     "templates/.runtime/secret.xml", "templates/data/home.db", "templates/.git/config",
                     "templates/private.key", "templates/home.sqlite3", "templates/dist/generated.xml"]
        for name in forbidden:
            with self.subTest(path=name), self.assertRaises(release.ValidationError):
                release.safe_path(name, source=True)
        self.assertEqual(str(release.safe_path("web/dist/index.html")), "web/dist/index.html")
        self.assertEqual(str(release.safe_path("server/internal/home/integrations_data.go", source=True)),
                         "server/internal/home/integrations_data.go")
        self.assertEqual(str(release.safe_path("web/src/dist.ts", source=True)), "web/src/dist.ts")

    def test_archive_validation_finishes_before_extracting_any_member(self):
        for bad_name, kind in [("design/private.md", tarfile.REGTYPE), ("examples/design/private.md", tarfile.REGTYPE),
                               ("templates/.env", tarfile.REGTYPE), ("templates/link.xml", tarfile.SYMTYPE),
                               ("examples/.runtime/private.json", tarfile.REGTYPE), ("examples/dashboard-data/link", tarfile.SYMTYPE),
                               ("docs/link", tarfile.SYMTYPE), ("web/dist.compose-previous/index.html", tarfile.REGTYPE),
                               ("README.md", tarfile.REGTYPE), ("docs/hard", tarfile.LNKTYPE),
                               ("docs/device", tarfile.CHRTYPE), ("../outside", tarfile.REGTYPE)]:
            with self.subTest(path=bad_name, kind=kind), tempfile.TemporaryDirectory(dir=self.root) as folder:
                root = Path(folder)
                archive_path = root / "fixture.tar"
                destination = root / "extracted"
                destination.mkdir()
                with tarfile.open(archive_path, "w") as archive:
                    good = tarfile.TarInfo("README.md")
                    good.size = 4
                    archive.addfile(good, io.BytesIO(b"safe"))
                    bad = tarfile.TarInfo(bad_name)
                    bad.type = kind
                    bad.linkname = "/etc/passwd" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                    if kind == tarfile.REGTYPE:
                        bad.size = 6
                    archive.addfile(bad, io.BytesIO(b"secret") if kind == tarfile.REGTYPE else None)
                with self.assertRaises(release.ValidationError):
                    release.extract_source(archive_path, destination)
                self.assertEqual(list(destination.iterdir()), [], "rejected archive must not partially extract")

    def test_real_symlink_is_never_followed_during_packaging(self):
        self.write("outside-secret", b"must not be packaged")
        source = self.root / "source"
        source.mkdir()
        (source / "README.md").symlink_to(self.root / "outside-secret")
        with self.assertRaises(release.ValidationError):
            release.archive_tree(source, self.root / "output.tar.gz", "product/", 1700000000, source=True)
        self.assertFalse((self.root / "output.tar.gz").exists())

    def metadata_fixture(self, version="1.2.3-rc.1+build.7"):
        commit = "1" * 40
        repository = "Example-Owner/Lingshu-Home"
        image_repository, image_tag = release.registry_coordinates(repository, version)
        prefix = "Lingshu-Home-" + version
        files = [f"{prefix}-linux-amd64.tar.gz", f"{prefix}-source.tar.gz", f"{prefix}-source.zip",
                 f"{prefix}-docker-linux-amd64.tar.gz", release.METADATA_FILE, release.NOTES_FILE]
        output = self.root / "artifacts"
        output.mkdir()
        for name in files:
            (output / name).write_bytes(("Synthetic hash fixture: " + name).encode())
        metadata = {"version": version, "tag": "v" + version, "commit": commit,
                    "artifactType": "application-linux-amd64", "prerelease": "-" in version.partition("+")[0],
                    "image": {"id": "sha256:" + "2" * 64, "repository": image_repository, "tag": image_tag,
                              "reference": image_repository + ":" + image_tag, "platform": "linux/amd64",
                              "archive": f"{prefix}-docker-linux-amd64.tar.gz"}, "artifacts": files}
        (output / release.METADATA_FILE).write_text(json.dumps(metadata))
        self.resum(output)
        return output, metadata, commit, repository

    def resum(self, output):
        files = sorted(path for path in output.iterdir() if path.name != "SHA256SUMS")
        (output / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in files))

    def test_download_verifier_checks_complete_hash_set_and_independent_identity(self):
        output, metadata, commit, repository = self.metadata_fixture()
        self.assertEqual(release.verify_artifacts(output, metadata["tag"], commit, repository), metadata)
        target = output / metadata["artifacts"][0]
        target.write_bytes(b"changed bytes after CI")
        with self.assertRaisesRegex(release.ValidationError, "checksum"):
            release.verify_artifacts(output, metadata["tag"], commit, repository)
        self.resum(output)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, metadata["tag"], "3" * 40, repository)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, "v1.2.4", commit, repository)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, metadata["tag"], commit, "Different/Repository")

    def test_extra_secret_or_missing_artifact_is_rejected_even_with_updated_checksums(self):
        output, metadata, commit, repository = self.metadata_fixture("1.2.3")
        (output / ".env").write_bytes(b"DO_NOT_UPLOAD=fixture")
        self.resum(output)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, metadata["tag"], commit, repository)
        (output / ".env").unlink()
        (output / metadata["artifacts"][0]).unlink()
        self.resum(output)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, metadata["tag"], commit, repository)

    def test_wrong_platform_image_reference_or_prerelease_cannot_be_published(self):
        output, metadata, commit, repository = self.metadata_fixture()
        original = json.dumps(metadata)
        for field, value in [("platform", "linux/arm64"), ("reference", "evil.example/home:latest"),
                             ("id", "sha256:not-a-digest"), ("archive", "../../image.tar.gz")]:
            with self.subTest(field=field):
                changed = json.loads(original)
                changed["image"][field] = value
                (output / release.METADATA_FILE).write_text(json.dumps(changed))
                self.resum(output)
                with self.assertRaises(release.ValidationError):
                    release.verify_artifacts(output, metadata["tag"], commit, repository)
        changed = json.loads(original)
        changed["prerelease"] = False
        (output / release.METADATA_FILE).write_text(json.dumps(changed))
        self.resum(output)
        with self.assertRaises(release.ValidationError):
            release.verify_artifacts(output, metadata["tag"], commit, repository)

    def test_docker_semver_mapping_is_explicit_and_does_not_drop_build_metadata(self):
        self.assertEqual(release.registry_coordinates("Example-Owner/Lingshu-Home", "1.2.3+build.4"),
                         ("ghcr.io/example-owner/lingshu-home", "1.2.3_build.4"))
        for repository, version in [("owner/repo/extra", "1.2.3"), ("owner/repo", "1.2.3;echo"),
                                    ("owner/repo", "1.2.3+" + "a" * 128), ("owner/repo", "01.2.3")]:
            with self.subTest(repository=repository, version=version), self.assertRaises(release.ValidationError):
                release.registry_coordinates(repository, version)

    def repository_fixture(self):
        for name in check_repository.REQUIRED_FILES:
            self.write(name, b"required public fixture\n")
        self.write("LICENSE", (check_repository.REPOSITORY_ROOT / "LICENSE").read_bytes())
        self.write("VERSION", b"1.2.3\n")
        self.write("CHANGELOG.md", b"# Changes\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-18\n\n- A described change.\n")

    def test_dirty_or_mismatched_tag_is_rejected_before_build_side_effects(self):
        self.repository_fixture()
        with mock.patch.object(release, "resolve_commit", return_value="1" * 40), \
                mock.patch.object(release, "git", return_value=" M README.md\n"), \
                mock.patch.object(release, "command") as command:
            with self.assertRaisesRegex(release.ValidationError, "clean checkout"):
                release.build(self.root, "v1.2.3", self.root / "output", "owner/repo")
            command.assert_not_called()
        with mock.patch.object(release, "resolve_commit", side_effect=["1" * 40, "2" * 40]), \
                mock.patch.object(release, "command") as command:
            with self.assertRaisesRegex(release.ValidationError, "HEAD"):
                release.build(self.root, "v1.2.3", self.root / "output", "owner/repo")
            command.assert_not_called()
        self.assertFalse((self.root / "output").exists())

    def test_release_requires_exact_version_and_real_dated_changelog_body(self):
        self.repository_fixture()
        with self.assertRaises(release.ValidationError):
            release.validate_checkout(self.root, "v1.2.4")
        for contents in [b"# Changes\n\n## [Unreleased]\n\n- Changes not yet released.\n",
                         b"# Changes\n\n## [Unreleased]\n\n## [1.2.3] - 2026-02-30\n\n- Invalid date.\n",
                         b"# Changes\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-18\n"]:
            self.write("CHANGELOG.md", contents)
            with self.subTest(changelog=contents), self.assertRaises(release.ValidationError):
                release.validate_checkout(self.root, "v1.2.3")

    def test_incorrect_binary_architecture_is_rejected_before_execution(self):
        bundle = self.root / "bundle"
        bundle.mkdir()
        (bundle / "lingshu-home").write_bytes(b"MZ" + b"\0" * 18)
        with mock.patch.object(release.subprocess, "Popen") as process:
            with self.assertRaisesRegex(release.ValidationError, "ELF64"):
                release.verify_linux_bundle(bundle, "1.2.3")
            process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
