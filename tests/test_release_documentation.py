"""Release documentation gates against disposable, local Git history.

No repository remote, registry, or published tag is read or modified.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_repository as checks


class ReleaseDocumentationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lingshu-release-docs-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / "repository"
        self.root.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Release policy fixture")
        self.git("config", "user.email", "release-fixture@example.invalid")

    def git(self, *args, cwd=None):
        return subprocess.check_output(["git", "-C", str(cwd or self.root), *args],
                                       text=True, stderr=subprocess.PIPE).strip()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def prepare(self, version, *, unchanged=(), future=""):
        self.write("VERSION", version + "\n")
        for name in ("README.md", "README.zh-CN.md"):
            if name not in unchanged:
                self.write(name, f"# {name}\n\nCurrent release: {version}.\n\nPlanned: {future}\n")
        if "CHANGELOG.md" not in unchanged:
            self.write("CHANGELOG.md", f"# Changes\n\n## [Unreleased]\n\n"
                                      f"## [{version}] - 2026-10-25\n\n- Describe behavior in {version}.\n")
        self.git("add", ".")
        self.git("commit", "-m", "Prepare " + version)
        return self.git("rev-parse", "HEAD")

    def initial(self, version="0.0.1", *, future=""):
        commit = self.prepare(version, future=future)
        self.git("tag", "-a", "v" + version, "-m", "Local release fixture")
        return commit

    def validate(self, version, *, root=None):
        output = io.StringIO()
        with redirect_stdout(output):
            checks.validate_release_documentation(root or self.root, version)
        return output.getvalue()

    def test_first_release_requires_committed_bilingual_documentation_without_head_parent(self):
        self.prepare("0.0.1")
        self.assertIn("First release", self.validate("0.0.1"))
        self.git("tag", "v0.0.1")
        self.assertIn("First release", self.validate("0.0.1"))

    def test_release_with_both_readmes_and_notes_updated_passes(self):
        self.initial()
        self.prepare("0.0.2")
        self.git("tag", "v0.0.2")
        self.assertIn("since v0.0.1", self.validate("0.0.2"))

    def test_current_version_mention_does_not_replace_an_english_readme_update(self):
        self.initial(future="0.0.2")
        self.prepare("0.0.2", unchanged=("README.md",))
        with self.assertRaisesRegex(checks.ValidationError, "unchanged or removed: README.md"):
            self.validate("0.0.2")

    def test_current_version_mention_does_not_replace_a_chinese_readme_update(self):
        self.initial(future="0.0.2")
        self.prepare("0.0.2", unchanged=("README.zh-CN.md",))
        with self.assertRaisesRegex(checks.ValidationError, "unchanged or removed: README.zh-CN.md"):
            self.validate("0.0.2")

    def test_readme_updates_do_not_replace_updated_release_notes(self):
        self.initial()
        self.prepare("0.0.2", unchanged=("CHANGELOG.md",))
        with self.assertRaisesRegex(checks.ValidationError, "unchanged or removed: CHANGELOG.md"):
            self.validate("0.0.2")

    def test_missing_translation_is_rejected_for_release(self):
        self.prepare("0.0.1")
        (self.root / "README.zh-CN.md").unlink()
        self.git("add", "-u")
        self.git("commit", "-m", "Remove fixture translation")
        with self.assertRaisesRegex(checks.ValidationError, "requires README.zh-CN.md"):
            self.validate("0.0.1")

    def test_similar_versions_do_not_satisfy_current_readme_version(self):
        self.prepare("1.2.3")
        for wrong in ("1.2.30", "1.2.3-rc.1", "1.2.3+old", "11.2.3"):
            with self.subTest(version=wrong):
                self.write("README.md", f"# Current release {wrong}\n")
                with self.assertRaisesRegex(checks.ValidationError, "requires README.md.*exact current version"):
                    self.validate("1.2.3")

    def test_prerelease_tag_is_the_baseline_for_the_next_prerelease(self):
        self.initial("0.0.2")
        self.prepare("0.0.3-rc.1", future="0.0.3-rc.2")
        self.git("tag", "v0.0.3-rc.1")
        self.prepare("0.0.3-rc.2", unchanged=("README.zh-CN.md",))
        with self.assertRaisesRegex(checks.ValidationError, "since v0.0.3-rc.1"):
            self.validate("0.0.3-rc.2")

    def test_numeric_semver_baseline_and_stable_following_prerelease(self):
        self.initial("0.0.9")
        self.prepare("0.0.10-rc.2")
        self.git("tag", "v0.0.10-rc.2")
        self.prepare("0.0.10-rc.10")
        self.git("tag", "v0.0.10-rc.10")
        self.prepare("0.0.10")
        self.assertIn("since v0.0.10-rc.10", self.validate("0.0.10"))

    def test_build_metadata_release_still_requires_fresh_documentation(self):
        self.initial("1.2.3+build.1", future="1.2.3+build.2")
        self.prepare("1.2.3+build.2", unchanged=("README.zh-CN.md",))
        with self.assertRaisesRegex(checks.ValidationError, r"since v1\.2\.3\+build\.1"):
            self.validate("1.2.3+build.2")

    def test_nonrelease_checkpoint_and_higher_development_tags_do_not_change_baseline(self):
        self.initial("0.0.1")
        self.git("tag", "checkpoint-ready")
        self.git("tag", "vgarbage")
        self.git("tag", "v0.0.2-rc.1")  # Does not match that commit's VERSION.
        self.prepare("0.1.0-dev.1")
        self.git("tag", "v0.1.0-dev.1")
        self.prepare("0.0.2")
        self.assertIn("since v0.0.1", self.validate("0.0.2"))

    def test_release_tags_on_unmerged_branches_are_not_the_baseline(self):
        base = self.initial("0.0.1")
        self.git("checkout", "-b", "unmerged-release")
        self.prepare("0.0.2")
        self.git("tag", "v0.0.2")
        self.git("checkout", "main")
        self.assertEqual(self.git("rev-parse", "HEAD"), base)
        self.prepare("0.0.3")
        self.assertIn("since v0.0.1", self.validate("0.0.3"))

    def test_uncommitted_readme_fix_cannot_mask_an_incomplete_release_commit(self):
        self.initial(future="0.0.2")
        self.prepare("0.0.2", unchanged=("README.zh-CN.md",))
        self.write("README.zh-CN.md", "# 当前版本 0.0.2\n\n增加发布说明。\n")
        with self.assertRaisesRegex(checks.ValidationError, "README.zh-CN.md differs from HEAD"):
            self.validate("0.0.2")

    def test_shallow_checkout_cannot_silently_be_treated_as_a_first_release(self):
        self.initial()
        self.prepare("0.0.2")
        clone = self.directory / "shallow"
        self.git("clone", "--depth=1", self.root.as_uri(), str(clone))
        with self.assertRaisesRegex(checks.ValidationError, "full Git history"):
            self.validate("0.0.2", root=clone)

    def test_linked_worktree_uses_release_history_when_git_marker_is_a_file(self):
        self.initial()
        self.prepare("0.0.2")
        linked = self.directory / "linked"
        self.git("worktree", "add", "--detach", str(linked), "HEAD")
        self.assertTrue((linked / ".git").is_file())
        self.assertIn("since v0.0.1", self.validate("0.0.2", root=linked))

    def test_source_archive_rechecks_content_without_using_its_parent_repository(self):
        self.initial()
        self.prepare("0.0.2")
        archive_bytes = subprocess.check_output(["git", "-C", str(self.root), "archive", "--format=zip", "HEAD"])
        extracted = self.root / "nested-archive"
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            archive.extractall(extracted)
        self.assertFalse((extracted / ".git").exists())
        # The parent is deliberately dirty: a Git parent search would validate
        # the wrong files and fail an otherwise valid, extracted source tree.
        self.write("README.zh-CN.md", "# Parent working copy changed\n")
        self.assertEqual(self.validate("0.0.2", root=extracted), "")
        (extracted / "README.zh-CN.md").write_text("# 旧版本 0.0.1\n", encoding="utf-8")
        with self.assertRaisesRegex(checks.ValidationError, "requires README.zh-CN.md"):
            self.validate("0.0.2", root=extracted)

    def test_ordinary_development_documentation_rule_remains_unchanged(self):
        base = self.initial()
        self.write("CHANGELOG.md", "# Changes\n\n## [Unreleased]\n\n- Explain development change.\n")
        self.write("docs/FEATURE.md", "# Describe the development behavior\n")
        self.git("add", ".")
        self.git("commit", "-m", "Development change without a release")
        with redirect_stdout(io.StringIO()):
            checks.validate_documentation_changes(self.root, base, "HEAD", "direct")


if __name__ == "__main__":
    unittest.main()
