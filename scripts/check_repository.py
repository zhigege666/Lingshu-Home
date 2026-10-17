#!/usr/bin/env python3
"""Validate repository metadata and documentation discipline using the stdlib.

Examples:
  python3 scripts/check_repository.py
  python3 scripts/check_repository.py --base <base-sha> --head <head-sha>
  python3 scripts/check_repository.py --base <before-sha> --head HEAD --diff-mode direct
  python3 scripts/check_repository.py --tag v0.1.0-dev.1

This checks file structure and changed paths. A passing result does not prove
that documentation accurately describes the implementation; reviewers own that.
"""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
from pathlib import Path
import re
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
APACHE_20_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
# SemVer 2.0.0: ASCII identifiers, no leading zeroes in numeric identifiers.
# Reference: https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?",
    re.ASCII,
)
CHANGELOG_HEADING = re.compile(r"^## \[([^\]\r\n]+)\](?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?$", re.MULTILINE)
REQUIRED_FILES = (
    "README.md", "LICENSE", "VERSION", "CHANGELOG.md", "AGENTS.md",
    ".github/PULL_REQUEST_TEMPLATE.md", ".github/release.yml",
    ".github/workflows/ci.yml", ".github/workflows/release.yml",
    "scripts/check_repository.py", "scripts/build_source_release.py",
)


class ValidationError(ValueError):
    """An actionable repository policy failure."""


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValidationError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def read_version(root: Path) -> str:
    raw = (root / "VERSION").read_bytes()
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValidationError("VERSION must contain one ASCII SemVer value.") from exc
    version = text.removesuffix("\n")
    if not SEMVER.fullmatch(version) or text != version + "\n":
        raise ValidationError("VERSION must contain one strict SemVer value and one final LF, e.g. 0.1.0-dev.1.")
    return version


def changelog_sections(root: Path) -> dict[str, str]:
    text = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    headings = list(CHANGELOG_HEADING.finditer(text))
    level_two = re.findall(r"^## .+$", text, flags=re.MULTILINE)
    if len(headings) != len(level_two):
        raise ValidationError("CHANGELOG level-2 headings must be '## [Unreleased]' or '## [VERSION] - YYYY-MM-DD'.")
    if not headings or headings[0].group(1) != "Unreleased":
        raise ValidationError("CHANGELOG must begin its version sections with '## [Unreleased]'.")
    sections: dict[str, str] = {}
    for index, heading in enumerate(headings):
        version, release_date = heading.groups()
        if version in sections:
            raise ValidationError(f"Duplicate CHANGELOG section: {version}.")
        if version == "Unreleased":
            if release_date:
                raise ValidationError("Unreleased must not have a release date.")
        else:
            if not SEMVER.fullmatch(version) or not release_date:
                raise ValidationError(f"Invalid CHANGELOG version/date: {heading.group(0)}.")
            try:
                date.fromisoformat(release_date)
            except ValueError as exc:
                raise ValidationError(f"Invalid release date: {release_date}.") from exc
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        # Keep the selected section, including its heading, without other releases.
        sections[version] = text[heading.start():end].rstrip() + "\n"
    return sections


def validate_repository(root: Path, tag: str | None = None) -> tuple[str, dict[str, str]]:
    missing = [name for name in REQUIRED_FILES if not (root / name).is_file()]
    if missing:
        raise ValidationError("Missing required files: " + ", ".join(missing))
    empty = [name for name in REQUIRED_FILES if not (root / name).stat().st_size]
    if empty:
        raise ValidationError("Required files must not be empty: " + ", ".join(empty))
    license_digest = hashlib.sha256((root / "LICENSE").read_bytes()).hexdigest()
    if license_digest != APACHE_20_SHA256:
        raise ValidationError("LICENSE must be the unchanged Apache-2.0 text from https://www.apache.org/licenses/LICENSE-2.0.txt.")
    version = read_version(root)
    sections = changelog_sections(root)
    if tag is not None:
        if tag != f"v{version}":
            raise ValidationError(f"Release tag {tag!r} does not match VERSION ({version}); expected v{version}.")
        if version not in sections:
            raise ValidationError(f"Release requires a dated '## [{version}] - YYYY-MM-DD' CHANGELOG section.")
        body = sections[version].partition("\n")[2]
        # A heading-only version section is not a release description.
        if not any(line.strip() and not line.startswith("#") for line in body.splitlines()):
            raise ValidationError(f"CHANGELOG section {version} has no release description.")
    return version, sections


def resolve_commit(root: Path, revision: str) -> str:
    if revision.startswith("-") or "\x00" in revision:
        raise ValidationError("Invalid Git revision.")
    return git(root, "rev-parse", "--verify", f"{revision}^{{commit}}").strip()


def changed_paths(root: Path, base: str, head: str, diff_mode: str) -> tuple[set[str], set[str]]:
    head_commit = resolve_commit(root, head)
    # GitHub uses an all-zero 'before' on the first push. Compare with an empty
    # repository by enumerating the entire target tree; do not assume HEAD^ exists.
    if re.fullmatch(r"0{40}|0{64}", base):
        paths = set(filter(None, git(root, "ls-tree", "-r", "--name-only", "-z", head_commit).split("\x00")))
        return paths, paths
    base_commit = resolve_commit(root, base)
    if diff_mode == "merge-base":
        base_commit = git(root, "merge-base", base_commit, head_commit).strip()
    common = ("diff", "--no-renames", "--name-only", "-z", base_commit, head_commit)
    changed = set(filter(None, git(root, *common, "--").split("\x00")))
    maintained = set(filter(None, git(root, *common, "--diff-filter=AMT", "--").split("\x00")))
    return changed, maintained


def validate_documentation_changes(root: Path, base: str, head: str, diff_mode: str) -> None:
    changed, maintained = changed_paths(root, base, head, diff_mode)
    if not changed:
        print("No file changes in the supplied range; documentation-change check skipped.")
        return
    if "CHANGELOG.md" not in maintained:
        raise ValidationError("Every change must maintain CHANGELOG.md (normally its Unreleased section).")
    if not any(path == "README.md" or (path.startswith("docs/") and path.endswith(".md")) for path in maintained):
        raise ValidationError("Every change must also maintain README.md or a Markdown file under docs/.")
    print(f"Documentation paths maintained for {len(changed)} changed files; semantic accuracy still requires review.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--tag", help="Require tag == v<VERSION> and matching dated release notes.")
    parser.add_argument("--base", help="Base revision; use GitHub's all-zero before SHA for an initial push.")
    parser.add_argument("--head", default="HEAD", help="Head revision for the changed-path check.")
    parser.add_argument("--diff-mode", choices=("merge-base", "direct"), default="merge-base")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        version, _ = validate_repository(root, args.tag)
        if args.base is not None:
            validate_documentation_changes(root, args.base, args.head, args.diff_mode)
        print(f"Repository checks passed: VERSION={version}" + (f", tag={args.tag}" if args.tag else ""))
        return 0
    except (ValidationError, OSError, UnicodeError) as exc:
        print(f"Repository check failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
