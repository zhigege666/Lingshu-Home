#!/usr/bin/env python3
"""Package a tagged source/assets snapshot; never publish or build app binaries.

Requires Python 3.10+ and Git, with no third-party Python packages.
Example: python3 scripts/build_source_release.py --tag v0.1.0-dev.1 --output dist/source
The supplied tag must exist locally and point at the clean checked-out commit.
Only tracked files from that commit are packaged by git archive.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from check_repository import REPOSITORY_ROOT, SEMVER, ValidationError, git, resolve_commit, validate_repository


def build(root: Path, tag: str, output: Path) -> dict[str, object]:
    version, sections = validate_repository(root, tag)
    head = resolve_commit(root, "HEAD")
    tagged = resolve_commit(root, f"refs/tags/{tag}")
    if head != tagged:
        raise ValidationError(f"HEAD ({head}) does not match release tag {tag} ({tagged}).")
    if git(root, "status", "--porcelain", "--untracked-files=no").strip():
        raise ValidationError("Tracked working-tree/index changes exist; commit them before building a release.")
    # Root-level generated files must not accidentally be included in a release.
    # git archive selects the validated commit, never local/untracked files.
    output.mkdir(parents=True, exist_ok=True)
    basename = f"Lingshu-Home-{version}-source"
    archive_prefix = f"Lingshu-Home-{version}/"
    tar_path = output / f"{basename}.tar.gz"
    zip_path = output / f"{basename}.zip"
    sums_path = output / "SHA256SUMS"
    notes_path = output / "release-notes.md"
    artifact_paths = (tar_path, zip_path, notes_path, sums_path)
    if any(path.exists() for path in artifact_paths):
        raise ValidationError("Release output already exists; select a fresh output directory to avoid overwriting artifacts.")
    # git archive fixes entry timestamps to the commit time. Suppress gzip's
    # filename/time fields so repeated builds of the same commit are stable.
    with tar_path.open("xb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as compressed:
            process = subprocess.Popen(
                ["git", "-C", str(root), "archive", "--format=tar", f"--prefix={archive_prefix}", head],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            assert process.stdout is not None
            while chunk := process.stdout.read(1024 * 1024):
                compressed.write(chunk)
            process.stdout.close()
            assert process.stderr is not None
            error = process.stderr.read().decode("utf-8", errors="replace")
            if process.wait():
                raise ValidationError(f"git archive failed: {error.strip()}")
    git(root, "archive", "--format=zip", f"--prefix={archive_prefix}", f"--output={zip_path}", head)
    notes = (
        f"# Lingshu-Home {tag}\n\n"
        "**发布物类型 / Artifact type: Source and bundled assets only.**\n\n"
        "本次仅包含该标签对应的已跟踪源码、公开文档与内置资产，以及 SHA-256 校验清单。"
        "不包含可运行的 Docker 镜像、Linux 服务程序、Windows 安装包或 macOS 应用；"
        "文档中的产品功能仍以其实际实现状态为准。\n\n"
        "This release contains only the tracked source, public documentation and bundled assets from the tag. "
        "It does not provide a runnable Docker image, Linux server binary, Windows installer or macOS app.\n\n"
        f"Source commit: `{head}`\n\n"
        "## 本版本更新 / Changes in this release\n\n"
        + sections[version]
    )
    notes_path.write_text(notes, encoding="utf-8", newline="\n")
    hashes = []
    for path in (tar_path, zip_path, notes_path):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        hashes.append(f"{digest.hexdigest()}  {path.name}\n")
    sums_path.write_text("".join(hashes), encoding="ascii", newline="\n")
    match = SEMVER.fullmatch(version)
    assert match is not None
    metadata: dict[str, object] = {
        "version": version, "tag": tag, "commit": head,
        "artifact_type": "source-assets-only", "prerelease": match.group(4) is not None,
        "artifacts": [str(path) for path in artifact_paths],
        "notes": str(notes_path),
    }
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, default=Path("dist/source"))
    args = parser.parse_args()
    try:
        metadata = build(args.root.resolve(), args.tag, args.output.resolve())
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
        if github_output := os.environ.get("GITHUB_OUTPUT"):
            # Only validated, single-line metadata is passed to Actions outputs.
            with open(github_output, "a", encoding="utf-8") as handle:
                handle.write(f"version={metadata['version']}\n")
                handle.write(f"prerelease={str(metadata['prerelease']).lower()}\n")
        return 0
    except (ValidationError, OSError, UnicodeError) as exc:
        print(f"Source release build failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
