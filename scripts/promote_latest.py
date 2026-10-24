#!/usr/bin/env python3
"""Promote a verified, published stable image to latest without rebuilding it.

Run under the shared GitHub Actions concurrency lock. Reads are anonymous for
GHCR so a successful check also establishes public visibility. Only --apply
invokes Docker, using the runner's existing registry login.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


STABLE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
MANIFEST_TYPES = ("application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json")


class PromotionError(RuntimeError):
    pass


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise PromotionError("Refusing a non-HTTPS redirect.")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def read_url(url, headers=None, *, missing_ok=False):
    request = urllib.request.Request(url, headers={"User-Agent": "lingshu-home-latest-promotion", **(headers or {})})
    try:
        with urllib.request.build_opener(SafeRedirect()).open(request, timeout=30) as response:
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise PromotionError("Release/registry response exceeds the metadata size limit.")
            return body, response.headers
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        if missing_ok and status == 404:
            return None
        # Never include authorization headers or signed redirect URLs in logs.
        raise PromotionError(f"HTTP {status} reading {urllib.parse.urlsplit(url).path}") from None


def version_key(tag):
    match = STABLE.fullmatch(tag)
    return tuple(map(int, match.group(1, 2, 3))) if match else None


def stable_releases(releases):
    return [release for release in releases if release.get("draft") is False
            and release.get("prerelease") is False and release.get("published_at")
            and version_key(release.get("tag_name", "")) is not None]


def newest_release(releases):
    stable = stable_releases(releases)
    if not stable:
        raise PromotionError("No published stable SemVer release is available.")
    highest = max(version_key(release["tag_name"]) for release in stable)
    matches = [release for release in stable if version_key(release["tag_name"]) == highest]
    if len(matches) != 1:
        raise PromotionError("Multiple stable releases have equal SemVer precedence; promotion is ambiguous.")
    return matches[0]


class GitHub:
    def __init__(self, repository, token=""):
        self.repository = repository
        self.headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            self.headers["Authorization"] = "Bearer " + token

    def api(self, path):
        return json.loads(read_url(f"https://api.github.com/repos/{self.repository}/{path}", self.headers)[0])

    def releases(self):
        result = []
        for page in range(1, 101):
            batch = self.api(f"releases?per_page=100&page={page}")
            if not isinstance(batch, list):
                raise PromotionError("Unexpected GitHub releases response.")
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise PromotionError("Release pagination limit reached; refusing an incomplete version comparison.")

    def tag_commit(self, tag):
        obj = self.api("git/ref/tags/" + urllib.parse.quote(tag, safe=""))["object"]
        for _ in range(8):
            if obj["type"] == "commit":
                return obj["sha"]
            if obj["type"] != "tag":
                break
            obj = self.api("git/tags/" + obj["sha"])["object"]
        raise PromotionError("Release tag does not resolve to a commit.")

    def metadata(self, release):
        tag = release["tag_name"]
        for name in ("release-metadata.json", "SHA256SUMS"):
            assets = [asset for asset in release.get("assets", []) if asset.get("name") == name
                      and asset.get("state") == "uploaded" and asset.get("size", 0) > 0]
            if len(assets) != 1:
                raise PromotionError(f"{tag} must have one uploaded {name} asset.")
        base = f"https://github.com/{self.repository}/releases/download/{urllib.parse.quote(tag, safe='')}/"
        # Public asset URLs use no GitHub token, including on cross-host redirects.
        raw = read_url(base + "release-metadata.json")[0]
        checksums = read_url(base + "SHA256SUMS")[0].decode("ascii").splitlines()
        expected = [line.split()[0] for line in checksums
                    if len(line.split()) == 2 and line.split()[1] == "release-metadata.json"]
        if expected != [hashlib.sha256(raw).hexdigest()]:
            raise PromotionError("Published release metadata checksum does not match SHA256SUMS.")
        return json.loads(raw)


@dataclass(frozen=True)
class Manifest:
    digest: str
    config_id: str


class Registry:
    def __init__(self, repository):
        self.image = "ghcr.io/" + repository.lower()
        scope = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{repository.lower()}:pull"})
        token = json.loads(read_url("https://ghcr.io/token?" + scope)[0])["token"]
        self.headers = {"Authorization": "Bearer " + token}
        self.base = "https://ghcr.io/v2/" + repository.lower()

    def manifest(self, reference, *, missing_ok=False):
        result = read_url(self.base + "/manifests/" + urllib.parse.quote(reference, safe=":"),
                          {**self.headers, "Accept": ", ".join(MANIFEST_TYPES)}, missing_ok=missing_ok)
        if result is None:
            return None
        raw, headers = result
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        if headers.get("Docker-Content-Digest") != digest:
            raise PromotionError("Registry manifest content does not match its advertised digest.")
        data = json.loads(raw)
        if data.get("schemaVersion") != 2 or data.get("mediaType") not in MANIFEST_TYPES:
            raise PromotionError("Expected the release pipeline's single-platform image manifest.")
        config_id = data["config"]["digest"]
        if not DIGEST.fullmatch(config_id):
            raise PromotionError("Invalid image config digest.")
        return Manifest(digest, config_id)

    def config(self, manifest):
        raw = read_url(self.base + "/blobs/" + manifest.config_id, self.headers)[0]
        if "sha256:" + hashlib.sha256(raw).hexdigest() != manifest.config_id:
            raise PromotionError("Image config content does not match its digest.")
        return json.loads(raw)


def verified_image(github, registry, release):
    tag = release["tag_name"]
    version = tag[1:]
    image_tag = version.replace("+", "_")
    metadata = github.metadata(release)
    image = metadata.get("image", {})
    commit = github.tag_commit(tag)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise PromotionError("Invalid tagged source commit.")
    if (metadata.get("version") != version or metadata.get("tag") != tag
            or metadata.get("prerelease") is not False or metadata.get("commit") != commit
            or metadata.get("artifactType") != "application-linux-amd64"
            or image.get("repository") != registry.image or image.get("tag") != image_tag
            or image.get("reference") != registry.image + ":" + image_tag
            or image.get("platform") != "linux/amd64"):
        raise PromotionError("Release metadata does not match the stable tag, source commit and expected image.")
    manifest = registry.manifest(image_tag)
    config = registry.config(manifest)
    labels = config.get("config", {}).get("Labels") or {}
    if (manifest.config_id != image.get("id") or config.get("os") != "linux" or config.get("architecture") != "amd64"
            or labels.get("org.opencontainers.image.version") != version
            or labels.get("org.opencontainers.image.revision") != commit
            or labels.get("org.opencontainers.image.source", "").lower() != "https://github.com/" + github.repository.lower()):
        raise PromotionError("Registry image identity differs from the published release metadata.")
    return manifest


def promote(github, registry, *, apply=False, run=subprocess.run):
    releases = github.releases()
    release = newest_release(releases)
    tag = release["tag_name"]
    source = verified_image(github, registry, release)
    current = registry.manifest("latest", missing_ok=True)
    if current == source:
        print(f"{registry.image}:latest already matches {tag}: {source.digest}")
        return source
    if current is not None:
        labels = registry.config(current).get("config", {}).get("Labels") or {}
        current_tag = "v" + labels.get("org.opencontainers.image.version", "")
        matching = [item for item in stable_releases(releases) if item["tag_name"] == current_tag]
        if len(matching) != 1 or version_key(current_tag) > version_key(tag):
            raise PromotionError("Existing latest is not a recognized older stable release; refusing to overwrite it.")
        if verified_image(github, registry, matching[0]) != current:
            raise PromotionError("Existing latest does not match its published stable image; refusing to overwrite it.")
    # Select inside the workflow lock, then recheck immediately before writing.
    # A newer release published during validation must be handled by a fresh run.
    if newest_release(github.releases())["tag_name"] != tag:
        raise PromotionError("Highest stable release changed during validation; rerun promotion.")
    image_tag = tag[1:].replace("+", "_")
    if registry.manifest(image_tag) != source or registry.manifest("latest", missing_ok=True) != current:
        raise PromotionError("Registry tags changed during validation; rerun promotion.")
    print(f"Verified {tag}: {registry.image}@{source.digest} (config {source.config_id})")
    if not apply:
        print("Read-only check passed. Use --apply under the shared workflow lock to publish latest.")
        return source
    run(["docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag",
         registry.image + ":latest", registry.image + "@" + source.digest], check=True, timeout=180)
    if registry.manifest("latest") != source or registry.manifest(image_tag) != source:
        raise PromotionError("Post-publish digest verification failed; inspect latest and the exact version tag.")
    print(f"Published and read back {registry.image}:latest = {tag} = {source.digest}")
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "zhigege666/Lingshu-Home"))
    parser.add_argument("--apply", action="store_true", help="Publish latest using the existing Docker login")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("Expected an owner/repository name")
    try:
        github = GitHub(args.repository, os.environ.get("GH_TOKEN", os.environ.get("GITHUB_TOKEN", "")))
        promote(github, Registry(args.repository), apply=args.apply)
        return 0
    except (PromotionError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(f"Latest promotion failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
