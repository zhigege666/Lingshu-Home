"""Offline publication-boundary regressions; no registry credentials or writes."""

import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import promote_latest as promotion


class FakeGitHub:
    repository = "zhigege666/Lingshu-Home"

    def __init__(self):
        self.items = []
        self.documents = {}

    def releases(self):
        return copy.deepcopy(self.items)

    def metadata(self, release):
        return copy.deepcopy(self.documents[release["tag_name"]])

    def tag_commit(self, tag):
        return "a" * 40


class FakeRegistry:
    image = "ghcr.io/zhigege666/lingshu-home"

    def __init__(self):
        self.tags = {}
        self.configs = {}

    def manifest(self, reference, *, missing_ok=False):
        if reference in self.tags:
            return self.tags[reference]
        if missing_ok:
            return None
        raise promotion.PromotionError("HTTP 404 reading source manifest")

    def config(self, manifest):
        return copy.deepcopy(self.configs[manifest.config_id])


class PromotionTests(unittest.TestCase):
    def setUp(self):
        output = patch("sys.stdout", new=io.StringIO())
        output.start()
        self.addCleanup(output.stop)
        self.github = FakeGitHub()
        self.registry = FakeRegistry()
        self.add_release("0.0.1")
        self.add_release("0.0.2")
        self.writer = Mock(side_effect=self.publish)

    def add_release(self, version, **flags):
        tag = "v" + version
        image_tag = version.replace("+", "_")
        config = {"os": "linux", "architecture": "amd64", "config": {"Labels": {
            "org.opencontainers.image.version": version,
            "org.opencontainers.image.revision": "a" * 40,
            "org.opencontainers.image.source": "https://github.com/" + self.github.repository,
        }}}
        config_id = "sha256:" + hashlib.sha256(json.dumps(config).encode()).hexdigest()
        manifest = promotion.Manifest("sha256:" + hashlib.sha256(version.encode()).hexdigest(), config_id)
        self.registry.tags[image_tag] = manifest
        self.registry.configs[config_id] = config
        self.github.items.append({"tag_name": tag, "draft": False, "prerelease": False,
                                  "published_at": "2026-10-24T00:00:00Z", **flags})
        self.github.documents[tag] = {"version": version, "tag": tag, "commit": "a" * 40,
            "artifactType": "application-linux-amd64", "prerelease": False,
            "image": {"id": config_id, "repository": self.registry.image, "tag": image_tag,
                      "reference": self.registry.image + ":" + image_tag, "platform": "linux/amd64"}}

    def publish(self, command, **kwargs):
        self.assertEqual(command[:7], ["docker", "buildx", "imagetools", "create", "--prefer-index=false",
                                      "--tag", self.registry.image + ":latest"])
        digest = command[7].split("@", 1)[1]
        self.registry.tags["latest"] = next(value for value in self.registry.tags.values() if value.digest == digest)

    def apply(self):
        return promotion.promote(self.github, self.registry, apply=True, run=self.writer)

    def test_first_promotion_and_idempotent_retry(self):
        expected = self.registry.tags["0.0.2"]
        self.assertEqual(self.apply(), expected)
        self.writer.assert_called_once()
        self.assertEqual(self.registry.tags["latest"], expected)
        self.assertEqual(self.registry.tags["0.0.1"].digest, "sha256:" + hashlib.sha256(b"0.0.1").hexdigest())
        self.assertEqual(self.apply(), expected)
        self.writer.assert_called_once()

    def test_read_only_default_never_writes(self):
        promotion.promote(self.github, self.registry, run=self.writer)
        self.writer.assert_not_called()
        self.assertNotIn("latest", self.registry.tags)

    def test_old_release_retry_selects_highest_numeric_version(self):
        self.add_release("0.0.10")
        self.add_release("0.0.9")
        previous = self.registry.tags["0.0.2"]
        self.registry.tags["latest"] = previous
        self.assertEqual(self.apply(), self.registry.tags["0.0.10"])
        self.assertEqual(self.registry.tags["0.0.2"], previous)

    def test_drafts_prereleases_and_rc_tags_are_excluded(self):
        self.add_release("9.0.0", draft=True)
        self.add_release("8.0.0", prerelease=True)
        self.add_release("7.0.0-rc.1")
        self.assertEqual(self.apply(), self.registry.tags["0.0.2"])
        self.github.items = self.github.items[2:]
        self.writer.reset_mock()
        with self.assertRaisesRegex(promotion.PromotionError, "No published stable"):
            self.apply()
        self.writer.assert_not_called()

    def test_equal_highest_semver_build_metadata_is_ambiguous(self):
        for versions in [("0.0.2+one", "0.0.2+two"), ("0.0.2", "0.0.2+one")]:
            with self.subTest(versions=versions):
                self.github.items = []
                for version in versions:
                    self.add_release(version)
                with self.assertRaisesRegex(promotion.PromotionError, "ambiguous"):
                    self.apply()
        self.writer.assert_not_called()

    def test_build_metadata_tag_maps_to_docker_tag(self):
        self.add_release("0.0.3+build.7")
        self.assertEqual(self.apply(), self.registry.tags["0.0.3_build.7"])

    def test_unknown_or_unpublished_latest_is_never_overwritten(self):
        self.add_release("9.0.0")
        self.registry.tags["latest"] = self.registry.tags["9.0.0"]
        self.github.items.pop()
        with self.assertRaisesRegex(promotion.PromotionError, "not a recognized older stable"):
            self.apply()
        self.writer.assert_not_called()

    def test_known_version_with_unrecognized_latest_manifest_is_rejected(self):
        old = self.registry.tags["0.0.1"]
        self.registry.tags["latest"] = promotion.Manifest("sha256:" + "f" * 64, old.config_id)
        with self.assertRaisesRegex(promotion.PromotionError, "does not match its published"):
            self.apply()
        self.writer.assert_not_called()

    def test_release_metadata_identity_failures_never_write(self):
        original = copy.deepcopy(self.github.documents["v0.0.2"])
        cases = [("tag", "v0.0.1"), ("commit", "b" * 40), ("prerelease", True),
                 ("version", "0.0.3"), ("image.repository", "ghcr.io/another/project"),
                 ("image.id", "sha256:" + "f" * 64), ("image.platform", "linux/arm64")]
        for field, value in cases:
            with self.subTest(field=field):
                document = copy.deepcopy(original)
                if field.startswith("image."):
                    document["image"][field.split(".")[1]] = value
                else:
                    document[field] = value
                self.github.documents["v0.0.2"] = document
                with self.assertRaises(promotion.PromotionError):
                    self.apply()
                self.writer.assert_not_called()

    def test_mismatched_oci_labels_never_write(self):
        config_id = self.registry.tags["0.0.2"].config_id
        original = copy.deepcopy(self.registry.configs[config_id])
        for name in ("version", "revision", "source"):
            with self.subTest(label=name):
                config = copy.deepcopy(original)
                config["config"]["Labels"]["org.opencontainers.image." + name] = "unexpected"
                self.registry.configs[config_id] = config
                with self.assertRaisesRegex(promotion.PromotionError, "image identity"):
                    self.apply()
                self.writer.assert_not_called()

    def test_missing_source_tag_fails_before_writing(self):
        del self.registry.tags["0.0.2"]
        with self.assertRaisesRegex(promotion.PromotionError, "404"):
            self.apply()
        self.writer.assert_not_called()

    def test_newer_release_during_validation_requires_fresh_run(self):
        first = self.github.releases()
        self.add_release("0.0.3")
        with patch.object(self.github, "releases", side_effect=[first, self.github.releases()]):
            with self.assertRaisesRegex(promotion.PromotionError, "Highest stable release changed"):
                self.apply()
        self.writer.assert_not_called()

    def test_source_or_latest_change_before_write_is_rejected(self):
        original = self.registry.manifest
        for changed_tag in ("0.0.2", "latest"):
            count = 0
            def changing_manifest(reference, **kwargs):
                nonlocal count
                if reference == changed_tag:
                    count += 1
                    if count > 1:
                        return self.registry.tags["0.0.1"]
                return original(reference, **kwargs)
            with self.subTest(tag=changed_tag), patch.object(self.registry, "manifest", side_effect=changing_manifest):
                with self.assertRaisesRegex(promotion.PromotionError, "Registry tags changed"):
                    self.apply()
                self.writer.assert_not_called()

    def test_failed_push_or_incorrect_readback_does_not_report_success(self):
        self.writer.side_effect = subprocess.CalledProcessError(1, "docker")
        with self.assertRaises(subprocess.CalledProcessError):
            self.apply()
        self.writer.side_effect = lambda *args, **kwargs: self.registry.tags.update(latest=self.registry.tags["0.0.1"])
        with self.assertRaisesRegex(promotion.PromotionError, "Post-publish digest"):
            self.apply()

    def test_source_changed_after_write_fails_without_rollback(self):
        def publish_then_change_source(command, **kwargs):
            self.publish(command, **kwargs)
            self.registry.tags["0.0.2"] = self.registry.tags["0.0.1"]
        self.writer.side_effect = publish_then_change_source
        with self.assertRaisesRegex(promotion.PromotionError, "Post-publish digest"):
            self.apply()
        self.writer.assert_called_once()


class TransportTests(unittest.TestCase):
    def test_only_explicit_404_can_be_optional(self):
        for status in (401, 403, 404, 429, 500):
            error = urllib.error.HTTPError("https://ghcr.io/example", status, "error", {}, None)
            opener = Mock()
            opener.open.side_effect = error
            with self.subTest(status=status), patch.object(promotion.urllib.request, "build_opener", return_value=opener):
                if status == 404:
                    self.assertIsNone(promotion.read_url("https://ghcr.io/example", missing_ok=True))
                else:
                    with self.assertRaisesRegex(promotion.PromotionError, str(status)):
                        promotion.read_url("https://ghcr.io/example", missing_ok=True)
                with self.assertRaises(promotion.PromotionError):
                    promotion.read_url("https://ghcr.io/example")

    def test_cross_host_redirect_drops_authorization_and_rejects_http(self):
        request = urllib.request.Request("https://ghcr.io/a", headers={"Authorization": "Bearer private-test-value"})
        handler = promotion.SafeRedirect()
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://objects.example/a")
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaises(promotion.PromotionError):
            handler.redirect_request(request, None, 302, "Found", {}, "http://objects.example/a")

    def test_metadata_checksum_mismatch_is_rejected(self):
        release = {"tag_name": "v0.0.2", "assets": [
            {"name": name, "state": "uploaded", "size": 100} for name in ("release-metadata.json", "SHA256SUMS")]}
        responses = [(b'{}', {}), (("0" * 64 + "  release-metadata.json\n").encode(), {})]
        with patch.object(promotion, "read_url", side_effect=responses):
            with self.assertRaisesRegex(promotion.PromotionError, "checksum"):
                promotion.GitHub("owner/repo").metadata(release)

    def test_manifest_and_config_bytes_must_match_digests(self):
        registry = promotion.Registry.__new__(promotion.Registry)
        registry.base, registry.headers = "https://ghcr.io/v2/owner/repo", {}
        with patch.object(promotion, "read_url", return_value=(b'{}', {"Docker-Content-Digest": "sha256:" + "0" * 64})):
            with self.assertRaisesRegex(promotion.PromotionError, "manifest content"):
                registry.manifest("0.0.2")
            with self.assertRaisesRegex(promotion.PromotionError, "config content"):
                registry.config(promotion.Manifest("sha256:" + "0" * 64, "sha256:" + "0" * 64))

    def test_release_pagination_is_not_limited_to_first_page(self):
        github = promotion.GitHub("owner/repo")
        with patch.object(github, "api", side_effect=[[{}] * 100, [{"tag_name": "v9.0.0"}]]):
            self.assertEqual(len(github.releases()), 101)


if __name__ == "__main__":
    unittest.main()
