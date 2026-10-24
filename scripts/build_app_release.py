#!/usr/bin/env python3
"""Build a Linux amd64 application release from a clean, existing version tag.

The Dockerfile builds one image. The image is tested, and its actual binary,
frontend and notices become the Linux download. The same image is saved for a
later publish job; this script never logs in, pushes an image or creates a release.
Requires Linux amd64, Python 3.10+, Git and Docker. No Python packages are needed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
import zipfile

from check_repository import REPOSITORY_ROOT, SEMVER, ValidationError, git, resolve_commit, validate_repository


SOURCE_ROOTS = {
    ".github", ".dockerignore", ".gitattributes", ".gitignore", "AGENTS.md",
    "README.md", "README.zh-CN.md", "VERSION", "LICENSE", "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md", "Dockerfile", "compose.yaml", "compose.postgres.yaml",
    "assets", "ca_profile.xml", "docs", "examples", "scripts", "server", "templates", "tests", "web",
}
PRIVATE_PARTS = {"design", ".runtime", "data", "uploads", ".git", ".gitnexus", "node_modules", "__pycache__"}
PRIVATE_SUFFIXES = (".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".key", ".pfx", ".p12", ".pyc")
IMAGE_APP_ROOTS = {"lingshu-home", "wwwroot", "licenses", "VERSION", "LICENSE", "THIRD_PARTY_NOTICES.md"}
METADATA_FILE = "release-metadata.json"
NOTES_FILE = "release-notes.md"


def command(*words: str, cwd: Path | None = None, capture: bool = False) -> str:
    completed = subprocess.run(words, cwd=cwd, check=True, text=True,
                               stdout=subprocess.PIPE if capture else None)
    return completed.stdout.strip() if capture else ""


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def safe_path(name: str, *, source: bool = False) -> PurePosixPath:
    path = PurePosixPath(name)
    if (not name or not path.parts or path.is_absolute() or "\\" in name or str(path) != name.rstrip("/")
            or any(part in (".", "..") for part in path.parts)
            or any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise ValidationError(f"Unsafe archive path: {name!r}.")
    if (any(part.lower() in PRIVATE_PARTS or part.lower().startswith(".env") for part in path.parts)
            or name.lower().endswith(PRIVATE_SUFFIXES)):
        raise ValidationError(f"Private/runtime material is forbidden in release artifacts: {name!r}.")
    if source and (path.parts[0] not in SOURCE_ROOTS
                   or any(part in {"dist", "bin", "obj", "target"} for part in path.parts)
                   or (len(path.parts) > 1 and path.parts[0] == "web" and path.parts[1].startswith("dist."))):
        raise ValidationError(f"Path is outside the reviewed source release allowlist: {name!r}.")
    return path


def checked_files(root: Path, *, source: bool = False) -> list[Path]:
    files = []
    for path in sorted(root.rglob("*")):
        safe_path(path.relative_to(root).as_posix(), source=source)
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValidationError(f"Release material must contain regular files/directories: {path.name}.")
        if path.is_file():
            files.append(path)
    return files


def extract_source(archive: Path, destination: Path) -> None:
    """Validate every entry before extracting anything; links are never followed."""
    with tarfile.open(archive, "r:") as handle:
        members = handle.getmembers()
        seen = set()
        for member in members:
            name = str(safe_path(member.name, source=True))
            if name in seen or not (member.isdir() or member.isfile()):
                raise ValidationError(f"Duplicate or non-regular source archive entry: {member.name!r}.")
            seen.add(name)
        for member in members:
            path = destination / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with handle.extractfile(member) as data, path.open("xb") as target:
                shutil.copyfileobj(data, target)
            path.chmod(0o755 if member.mode & 0o111 else 0o644)


def archive_tree(root: Path, target: Path, prefix: str, timestamp: int, *, source: bool = False) -> None:
    files = checked_files(root, source=source)
    if not files:
        raise ValidationError("Cannot package an empty release tree.")
    if target.name.endswith(".zip"):
        stamp = datetime.fromtimestamp(max(timestamp, 315532800), timezone.utc).timetuple()[:6]
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in files:
                entry = zipfile.ZipInfo(prefix + path.relative_to(root).as_posix(), stamp)
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = 3
                entry.external_attr = (0o100755 if path.stat().st_mode & 0o111 else 0o100644) << 16
                archive.writestr(entry, path.read_bytes())
    else:
        with target.open("xb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for path in files:
                    entry = archive.gettarinfo(str(path), prefix + path.relative_to(root).as_posix())
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ""
                    entry.mtime = timestamp
                    entry.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    with path.open("rb") as data:
                        archive.addfile(entry, data)


def registry_coordinates(repository: str, version: str) -> tuple[str, str]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise ValidationError("Repository must be an owner/name GitHub identifier.")
    # Docker tags cannot contain '+'. SemVer identifiers cannot contain '_', so
    # this mapping is unambiguous and retains build metadata in release identity.
    image_tag = version.replace("+", "_")
    if not SEMVER.fullmatch(version) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", image_tag):
        raise ValidationError("Version must be valid SemVer and fit a 128-character Docker tag.")
    return "ghcr.io/" + repository.lower(), image_tag


def validate_checkout(root: Path, tag: str) -> tuple[str, str, str, int]:
    version, sections = validate_repository(root, tag)
    head = resolve_commit(root, "HEAD")
    if resolve_commit(root, f"refs/tags/{tag}") != head:
        raise ValidationError("Release tag must point at the checked-out HEAD commit.")
    if git(root, "status", "--porcelain", "--untracked-files=all").strip():
        raise ValidationError("Release requires a clean checkout, including untracked non-ignored files.")
    timestamp = int(git(root, "show", "-s", "--format=%ct", head).strip())
    return version, head, sections[version], timestamp


def verify_linux_bundle(bundle: Path, version: str) -> None:
    """Exercise the extracted program with its actual default VERSION/web paths."""
    with (bundle / "lingshu-home").open("rb") as binary:
        header = binary.read(20)
    if header[:6] != b"\x7fELF\x02\x01" or header[18:20] != b"\x3e\x00":
        raise ValidationError("Linux bundle does not contain an ELF64 little-endian x86-64 program.")
    with tempfile.TemporaryDirectory(prefix="lingshu-release-smoke-") as scratch:
        temporary = Path(scratch)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        env = {key: value for key, value in os.environ.items() if not key.startswith("LINGSHU_")}
        env.update({"LINGSHU_LISTEN": f"127.0.0.1:{port}", "LINGSHU_DATA_DIR": str(temporary / "data"),
                    "LINGSHU_STORAGE_PROVIDER": "sqlite", "LINGSHU_SECURE_COOKIES": "false",
                    "LINGSHU_LANGUAGE": "zh-CN"})

        def request(path: str, data: dict | None = None, csrf: str = "") -> bytes:
            headers = {"Accept": "application/json"}
            if data is not None:
                headers.update({"Content-Type": "application/json", "X-CSRF-TOKEN": csrf})
            req = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None,
                                         headers=headers)
            with opener.open(req, timeout=5) as response:
                return response.read()

        for phase in ("setup", "restart"):
            with (temporary / "server.log").open("ab") as log:
                (temporary / "server.log").chmod(0o600)
                process = subprocess.Popen([str(bundle / "lingshu-home")], cwd=bundle, env=env,
                                           stdout=log, stderr=subprocess.STDOUT)
                try:
                    for _ in range(150):
                        if process.poll() is not None:
                            raise ValidationError("Extracted Linux program exited before becoming healthy.")
                        try:
                            request("/health")
                            break
                        except OSError:
                            time.sleep(0.1)
                    else:
                        raise ValidationError("Extracted Linux program did not become healthy.")
                    boot = json.loads(request("/api/v1/bootstrap"))
                    if boot.get("version") != version or boot.get("initialized") != (phase == "restart"):
                        raise ValidationError("Extracted Linux bundle version/setup persistence check failed.")
                    if boot.get("language") != "zh-CN":
                        raise ValidationError("Extracted Linux bundle did not retain its explicit fixture language.")
                    if phase == "setup":
                        request("/api/v1/setup", {"siteName": "Release bundle check", "mode": "open_edit", "seedDemo": False}, boot["csrfToken"])
                    elif boot.get("siteName") != "Release bundle check":
                        raise ValidationError("Extracted Linux bundle lost its setup after restart.")
                    html = request("/").decode("utf-8")
                    assets = re.findall(r'(?:src|href)="(/assets/[^"?#]+\.(?:js|css))"', html)
                    if "<html" not in html.lower() or not assets:
                        raise ValidationError("Extracted Linux bundle does not serve the built frontend.")
                    for asset in assets:
                        expected_asset = bundle / "web/dist" / asset.removeprefix("/")
                        if not expected_asset.is_file() or request(asset) != expected_asset.read_bytes():
                            raise ValidationError("Extracted Linux bundle did not serve the exact built frontend asset.")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=25)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                            raise ValidationError("Extracted Linux program did not stop gracefully.")


def release_notes(tag: str, commit: str, section: str, image_ref: str, image_id: str) -> str:
    return (
        f"# Lingshu-Home {tag}\n\n"
        "This release includes the Linux amd64 server with its built web interface and original dependency notices, "
        "the matching source archives, and the tested Docker image saved as an archive. "
        "The Linux program and frontend are extracted from that same image.\n\n"
        "本版本提供 Linux amd64 服务程序、已构建的网页与原始依赖许可、对应源码包，以及经过测试的 Docker 镜像归档。"
        "Linux 下载包与镜像使用同一份程序和前端文件。\n\n"
        f"Source commit: `{commit}`\n\n"
        f"Container: `{image_ref}` (Linux amd64)\n\n"
        f"Tested image config ID: `{image_id}`. This is an image identity, not a registry manifest digest.\n\n"
        "Verify downloads with `sha256sum --check SHA256SUMS`. Extract the Linux archive, enter its directory, "
        "and run `./lingshu-home`; then open http://127.0.0.1:5180. The persistent `data/` directory is created on first run. "
        "For containers, pull the image above or use `docker load --input <docker-archive.tar.gz>`. "
        "Keep `/data` on a persistent volume. Windows/macOS installers are not included.\n\n"
        "## Changes / 本版本更新\n\n" + section
    )


def verify_artifacts(output: Path, tag: str, commit: str, repository: str) -> dict:
    metadata = json.loads((output / METADATA_FILE).read_text("utf-8"))
    version = metadata.get("version", "")
    image_repository, image_tag = registry_coordinates(repository, version)
    if (metadata.get("tag") != tag or tag != "v" + version or metadata.get("commit") != commit
            or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit)
            or metadata.get("artifactType") != "application-linux-amd64"):
        raise ValidationError("Release metadata does not match the requested tag, commit or artifact type.")
    match = SEMVER.fullmatch(version)
    if metadata.get("prerelease") is not (match.group(4) is not None):
        raise ValidationError("Release prerelease classification is inconsistent.")
    image = metadata.get("image", {})
    image_id = image.get("id", "")
    if (image.get("repository") != image_repository or image.get("tag") != image_tag
            or image.get("reference") != image_repository + ":" + image_tag
            or image.get("platform") != "linux/amd64" or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)):
        raise ValidationError("Release image identity is inconsistent.")
    prefix = "Lingshu-Home-" + version
    expected = {f"{prefix}-linux-amd64.tar.gz", f"{prefix}-source.tar.gz", f"{prefix}-source.zip",
                f"{prefix}-docker-linux-amd64.tar.gz", METADATA_FILE, NOTES_FILE}
    if image.get("archive") != f"{prefix}-docker-linux-amd64.tar.gz" or set(metadata.get("artifacts", [])) != expected:
        raise ValidationError("Release does not contain the complete expected artifact set.")
    entries = {}
    for line in (output / "SHA256SUMS").read_text("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_.+\-]+)", line)
        if not match or match[2] in entries:
            raise ValidationError("Invalid or duplicate checksum entry.")
        entries[match[2]] = match[1]
    if set(entries) != expected or {path.name for path in output.iterdir()} != expected | {"SHA256SUMS"}:
        raise ValidationError("Release checksum coverage or output directory contains unexpected/missing files.")
    for name, expected_hash in entries.items():
        path = output / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected_hash:
            raise ValidationError(f"Release checksum verification failed for {name}.")
    return metadata


def build(root: Path, tag: str, output: Path, repository: str) -> dict:
    version, commit, section, timestamp = validate_checkout(root, tag)
    image_repository, image_tag = registry_coordinates(repository, version)
    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise ValidationError("This release target must be built and exercised on Linux amd64.")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValidationError("Select an empty release output directory; existing artifacts are never overwritten.")
    docker = os.environ.get("LINGSHU_DOCKER", "docker")
    image_ref = image_repository + ":" + image_tag
    local_image = "lingshu-home-release:" + commit
    prefix = "Lingshu-Home-" + version
    with tempfile.TemporaryDirectory(prefix="lingshu-release-build-") as scratch:
        work = Path(scratch)
        source = work / "source"
        source.mkdir()
        with (work / "source.tar").open("xb") as handle:
            subprocess.run(["git", "-C", str(root), "archive", "--format=tar", commit], stdout=handle, check=True)
        extract_source(work / "source.tar", source)
        # Check the committed metadata again; never trust only a working copy.
        if validate_repository(source, tag)[0] != version:
            raise ValidationError("Archived source has different version metadata.")
        artifacts = work / "artifacts"
        artifacts.mkdir()
        for suffix in ("tar.gz", "zip"):
            archive_tree(source, artifacts / f"{prefix}-source.{suffix}", prefix + "/", timestamp, source=True)
        command(docker, "build", "--platform", "linux/amd64", "--network=host",
                "--label", "org.opencontainers.image.source=https://github.com/" + repository,
                "--label", "org.opencontainers.image.revision=" + commit,
                "--label", "org.opencontainers.image.version=" + version,
                "--tag", local_image, ".", cwd=source)
        inspection = json.loads(command(docker, "image", "inspect", local_image, capture=True))[0]
        image_id = inspection["Id"]
        if inspection.get("Os") != "linux" or inspection.get("Architecture") != "amd64" or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise ValidationError("Built image does not match the Linux amd64 release target.")
        command(sys.executable, str(source / "scripts/check_container.py"), "--image", image_id, cwd=source)
        app = work / "app"
        app.mkdir()
        container = "lingshu-release-extract-" + uuid.uuid4().hex
        command(docker, "create", "--network=none", "--name", container, image_id)
        try:
            command(docker, "cp", container + ":/app/.", str(app))
        finally:
            command(docker, "rm", "--volumes", container)
        checked_files(app)
        if {path.name for path in app.iterdir()} != IMAGE_APP_ROOTS:
            raise ValidationError("Image /app contents differ from the reviewed release allowlist.")
        for required in ("lingshu-home", "wwwroot/index.html", "licenses/npm/manifest.json", "licenses/go/manifest.json",
                         "licenses/reui/LICENSE.md", "licenses/icons/lucide-LICENSE", "VERSION", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            if not (app / required).is_file() or not (app / required).stat().st_size:
                raise ValidationError(f"Built image is missing a required application/license file: {required}.")
        if (app / "VERSION").read_bytes() != (source / "VERSION").read_bytes() or digest(app / "LICENSE") != digest(source / "LICENSE"):
            raise ValidationError("Image version or project license differs from the tagged source.")
        bundle = work / "linux"
        bundle.mkdir()
        for name in ("lingshu-home", "VERSION", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(app / name, bundle / name)
        shutil.copytree(app / "wwwroot", bundle / "web/dist")
        shutil.copytree(app / "licenses", bundle / "licenses")
        shutil.copytree(source / "docs", bundle / "docs")
        for name in ("README.md", "README.zh-CN.md", "CHANGELOG.md"):
            shutil.copy2(source / name, bundle / name)
        (bundle / "RUNNING.md").write_text(
            "# Run the Linux amd64 release\n\nRun `./lingshu-home` from this directory and open http://127.0.0.1:5180. "
            "No Go or Node toolchain is needed. Use `./lingshu-home -help` for server options. "
            "On a new instance, choose its language before setup, or specify `--language en` / `--language zh-CN` at startup. "
            "The selected language is saved for later starts; the interface and example content use that language without a UI switch. "
            "Data and encryption keys are created in `data/`; retain and back up that directory. "
            "The `web/dist` and `VERSION` paths are relative to this working directory. "
            "The repository README also covers building from source, whose development scripts are in the separate source archive.\n\n"
            "在本目录运行 `./lingshu-home`，访问 http://127.0.0.1:5180 完成初始化。无需安装 Go 或 Node。"
            "新实例先选择语言，也可启动时指定 `--language zh-CN` 或 `--language en`；选择会保存，界面和示例内容统一使用该语言，之后不提供页面内切换。"
            "请保留并备份首次启动后生成的 `data/` 数据和密钥目录。\n", encoding="utf-8")
        verify_linux_bundle(bundle, version)
        archive_tree(bundle, artifacts / f"{prefix}-linux-amd64.tar.gz", prefix + "-linux-amd64/", timestamp)
        # Tag/save the already exercised image ID, not a second Docker build.
        command(docker, "tag", image_id, image_ref)
        saved = work / "image.tar"
        command(docker, "image", "save", "--output", str(saved), image_ref)
        image_archive = f"{prefix}-docker-linux-amd64.tar.gz"
        with saved.open("rb") as data, (artifacts / image_archive).open("xb") as target:
            with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
                shutil.copyfileobj(data, compressed)
        (artifacts / NOTES_FILE).write_text(release_notes(tag, commit, section, image_ref, image_id), encoding="utf-8")
        match = SEMVER.fullmatch(version)
        metadata = {
            "version": version, "tag": tag, "commit": commit, "sourceDateEpoch": timestamp,
            "artifactType": "application-linux-amd64", "prerelease": match.group(4) is not None,
            "image": {"id": image_id, "repository": image_repository, "tag": image_tag,
                      "reference": image_ref, "platform": "linux/amd64", "archive": image_archive},
            "artifacts": sorted([path.name for path in artifacts.iterdir()] + [METADATA_FILE]),
            "verification": ["version-and-dated-changelog", "clean-tagged-source-allowlist", "container-health-setup-restart-nonroot",
                             "linux-bundle-default-paths-assets-setup-restart", "required-original-license-notices"],
        }
        (artifacts / METADATA_FILE).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        (artifacts / "SHA256SUMS").write_text("".join(f"{digest(path)}  {path.name}\n" for path in sorted(artifacts.iterdir())), encoding="ascii")
        verify_artifacts(artifacts, tag, commit, repository)
        output.mkdir(parents=True, exist_ok=True)
        for path in artifacts.iterdir():
            with path.open("rb") as data, (output / path.name).open("xb") as target:
                shutil.copyfileobj(data, target)
        return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "zhigege666/Lingshu-Home"))
    parser.add_argument("--output", type=Path, default=Path("dist/release"))
    parser.add_argument("--verify", action="store_true", help="Verify a downloaded complete artifact set without building or publishing.")
    parser.add_argument("--commit", help="Required expected source commit when using --verify.")
    args = parser.parse_args()
    try:
        if args.verify:
            if not args.commit:
                raise ValidationError("--verify requires an independently supplied --commit.")
            metadata = verify_artifacts(args.output.resolve(), args.tag, args.commit, args.repository)
        else:
            metadata = build(args.root.resolve(), args.tag, args.output.resolve(), args.repository)
        print(json.dumps(metadata, indent=2))
        if github_output := os.environ.get("GITHUB_OUTPUT"):
            with open(github_output, "a", encoding="utf-8") as handle:
                for key, value in {"version": metadata["version"], "prerelease": str(metadata["prerelease"]).lower(),
                                   "commit": metadata["commit"], "image_id": metadata["image"]["id"],
                                   "image_ref": metadata["image"]["reference"], "docker_archive": metadata["image"]["archive"]}.items():
                    handle.write(f"{key}={value}\n")
        return 0
    except (ValidationError, OSError, UnicodeError, ValueError, KeyError, TypeError, tarfile.TarError,
            subprocess.CalledProcessError) as exc:
        print(f"Application release failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
