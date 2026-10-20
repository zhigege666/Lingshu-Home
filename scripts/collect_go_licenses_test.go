package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func officialGoNoticeFixture(t *testing.T) (string, goLicenseFallback, []byte) {
	t.Helper()
	// This test is invoked from server/, matching the collector's documented cwd.
	original := filepath.Join("..", "assets", "licenses", "go")
	manifest, err := os.ReadFile(filepath.Join(original, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var entry goLicenseFallback
	if err := json.Unmarshal(manifest, &entry); err != nil {
		t.Fatal(err)
	}
	license, err := os.ReadFile(filepath.Join(original, "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	fixture := t.TempDir()
	if err := os.WriteFile(filepath.Join(fixture, "manifest.json"), manifest, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture, "LICENSE"), license, 0644); err != nil {
		t.Fatal(err)
	}
	return fixture, entry, license
}

func TestGoLicenseMissingDistributionNoticeUsesVerifiedOriginal(t *testing.T) {
	fallback, entry, original := officialGoNoticeFixture(t)
	goRoot, output := t.TempDir(), t.TempDir()
	record := record{Module: "go", Version: entry.RuntimeVersion, Files: []notice{{Source: "src/vendor/example/LICENSE"}}}
	if err := ensureGoLicense(&record, goRoot, fallback, entry.RuntimeVersion, output); err != nil {
		t.Fatal(err)
	}
	if len(record.Files) != 2 {
		t.Fatal("available vendor notices must be retained alongside the original Go license")
	}
	for _, file := range record.Files {
		if file.Source == entry.Source {
			copied, err := os.ReadFile(filepath.Join(output, file.Path))
			if err != nil || !bytes.Equal(copied, original) || file.SHA256 != entry.SHA256 {
				t.Fatal("fallback did not retain the exact verified original notice")
			}
			if _, err := os.Stat(filepath.Join(goRoot, "LICENSE")); !os.IsNotExist(err) {
				t.Fatal("collector must not modify the installed Go distribution")
			}
			return
		}
	}
	t.Fatal("fallback provenance was not included")
}

func TestGoLicensePresentDistributionNoticeDoesNotUseFallback(t *testing.T) {
	_, entry, original := officialGoNoticeFixture(t)
	goRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(goRoot, "LICENSE"), original, 0644); err != nil {
		t.Fatal(err)
	}
	record := record{Module: "go", Version: entry.RuntimeVersion, Files: []notice{{Source: "LICENSE"}}}
	if err := ensureGoLicense(&record, goRoot, filepath.Join(t.TempDir(), "nonexistent"), entry.RuntimeVersion, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if len(record.Files) != 1 || record.Files[0].Source != "LICENSE" {
		t.Fatal("existing distribution notice should keep its original provenance")
	}
}

func TestGoLicenseFallbackRejectsVersionHashSourceAndPathMismatch(t *testing.T) {
	for _, mismatch := range []string{"version", "hash", "source", "path", "symlink"} {
		t.Run(mismatch, func(t *testing.T) {
			fallback, entry, _ := officialGoNoticeFixture(t)
			version := entry.RuntimeVersion
			switch mismatch {
			case "version":
				version = "go0.0.0"
			case "hash":
				if err := os.WriteFile(filepath.Join(fallback, "LICENSE"), []byte("not the pinned original"), 0644); err != nil {
					t.Fatal(err)
				}
			case "source":
				entry.Source = "https://example.org/LICENSE"
			case "path":
				entry.File = "../LICENSE"
			case "symlink":
				if err := os.Rename(filepath.Join(fallback, "LICENSE"), filepath.Join(fallback, "original")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(fallback, "original"), filepath.Join(fallback, "LICENSE")); err != nil {
					t.Fatal(err)
				}
			}
			manifest, _ := json.Marshal(entry)
			if err := os.WriteFile(filepath.Join(fallback, "manifest.json"), manifest, 0644); err != nil {
				t.Fatal(err)
			}
			output := t.TempDir()
			record := record{Module: "go", Version: version}
			if err := ensureGoLicense(&record, t.TempDir(), fallback, version, output); err == nil {
				t.Fatal("unverified fallback must fail closed")
			}
			files, err := os.ReadDir(output)
			if err != nil || len(files) != 0 || len(record.Files) != 0 {
				t.Fatal("rejected fallback must not write a notice")
			}
		})
	}
}
