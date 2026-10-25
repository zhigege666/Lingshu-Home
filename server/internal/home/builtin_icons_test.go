package home

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The picker reads this manifest while writes are validated by builtinIcons.
// Keep both lists, their local assets, and the pinned upstream provenance in
// agreement so a selectable icon cannot fail to save or disappear after reload.
func TestBuiltinIconManifestContract(t *testing.T) {
	const upstreamCommit = "1ef60af944de207e0d5176905a0759ba12e6ee8d"
	const assetRoot = "../../../assets/icons"
	var manifest struct {
		SchemaVersion int `json:"schemaVersion"`
		Upstream      struct {
			Commit string `json:"commit"`
		} `json:"upstream"`
		Groups []struct {
			ID      string `json:"id"`
			Label   string `json:"label"`
			LabelEn string `json:"labelEn"`
		} `json:"groups"`
		Icons []struct {
			ID      string `json:"id"`
			Label   string `json:"label"`
			LabelEn string `json:"labelEn"`
			Group   string `json:"group"`
			File    string `json:"file"`
			Source  string `json:"source"`
			SHA256  string `json:"sha256"`
		} `json:"icons"`
	}

	body, err := os.ReadFile(filepath.Join(assetRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 1 {
		t.Errorf("unsupported icon manifest schema: %d", manifest.SchemaVersion)
	}
	if manifest.Upstream.Commit != upstreamCommit {
		t.Errorf("upstream commit = %q, want %q", manifest.Upstream.Commit, upstreamCommit)
	}
	if len(manifest.Icons) == 0 || len(manifest.Groups) == 0 {
		t.Fatal("icon manifest must contain icons and groups")
	}

	groups := make(map[string]bool, len(manifest.Groups))
	for _, group := range manifest.Groups {
		if strings.TrimSpace(group.ID) == "" || group.ID != strings.TrimSpace(group.ID) {
			t.Errorf("invalid group ID %q", group.ID)
		}
		if groups[group.ID] {
			t.Errorf("duplicate group ID %q", group.ID)
		}
		groups[group.ID] = true
		if strings.TrimSpace(group.Label) == "" || strings.TrimSpace(group.LabelEn) == "" {
			t.Errorf("group %q is missing its Chinese or English label", group.ID)
		}
	}

	ids := make(map[string]bool, len(manifest.Icons))
	iconIDPattern := regexp.MustCompile(`^lucide:[a-z0-9]+(?:-[a-z0-9]+)*$`)
	for _, icon := range manifest.Icons {
		if ids[icon.ID] {
			t.Errorf("duplicate icon ID %q", icon.ID)
		}
		ids[icon.ID] = true
		t.Run(icon.ID, func(t *testing.T) {
			if !iconIDPattern.MatchString(icon.ID) {
				t.Fatalf("invalid Lucide icon ID %q", icon.ID)
			}
			if !builtinIcons[icon.ID] {
				t.Errorf("picker icon %q is absent from the server allowlist", icon.ID)
			}
			if strings.TrimSpace(icon.Label) == "" || strings.TrimSpace(icon.LabelEn) == "" {
				t.Error("icon is missing its Chinese or English label")
			}
			if !groups[icon.Group] {
				t.Errorf("unknown icon group %q", icon.Group)
			}

			name := strings.TrimPrefix(icon.ID, "lucide:")
			wantFile := "lucide/" + name + ".svg"
			if icon.File != wantFile {
				t.Fatalf("icon file = %q, want %q", icon.File, wantFile)
			}
			wantSource := "https://raw.githubusercontent.com/lucide-icons/lucide/" + upstreamCommit + "/icons/" + name + ".svg"
			if icon.Source != wantSource {
				t.Errorf("icon source = %q, want %q", icon.Source, wantSource)
			}
			content, err := os.ReadFile(filepath.Join(assetRoot, filepath.FromSlash(wantFile)))
			if err != nil {
				t.Fatal(err)
			}
			if digest := fmt.Sprintf("%x", sha256.Sum256(content)); icon.SHA256 != digest {
				t.Errorf("icon SHA-256 = %q, actual file digest = %q", icon.SHA256, digest)
			}

			if got, err := validIcon(icon.ID, "lucide:folder"); err != nil || got != icon.ID {
				t.Errorf("picker icon cannot be saved: got %q, error %v", got, err)
			}
			if got, err := validIcon("", icon.ID); err != nil || got != icon.ID {
				t.Errorf("valid fallback not preserved: got %q, error %v", got, err)
			}
		})
	}

	if len(ids) != len(builtinIcons) {
		t.Errorf("manifest has %d distinct icons; server allowlist has %d", len(ids), len(builtinIcons))
	}
	for id, enabled := range builtinIcons {
		if !enabled || !ids[id] {
			t.Errorf("server allowlist entry %q (enabled=%t) has no matching selectable manifest icon", id, enabled)
		}
	}
}

func TestBuiltinIconValidationFallback(t *testing.T) {
	for _, test := range []struct {
		name     string
		value    string
		fallback string
		want     string
		wantErr  bool
	}{
		{name: "explicit selection", value: "lucide:star", fallback: "lucide:folder", want: "lucide:star"},
		{name: "category default", fallback: "lucide:folder", want: "lucide:folder"},
		{name: "website default", fallback: "lucide:globe", want: "lucide:globe"},
		{name: "unknown selection does not use fallback", value: "lucide:__unknown__", fallback: "lucide:folder", wantErr: true},
		{name: "wrong collection", value: "other:folder", fallback: "lucide:folder", wantErr: true},
		{name: "unknown fallback", fallback: "lucide:__unknown__", wantErr: true},
		{name: "empty fallback", wantErr: true},
		{name: "explicit selection ignores fallback", value: "lucide:star", fallback: "lucide:__unknown__", want: "lucide:star"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := validIcon(test.value, test.fallback)
			if (err != nil) != test.wantErr || got != test.want {
				t.Errorf("validIcon(%q, %q) = (%q, %v), want (%q, error=%t)", test.value, test.fallback, got, err, test.want, test.wantErr)
			}
		})
	}
}
