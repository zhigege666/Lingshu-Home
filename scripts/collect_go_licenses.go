// Run from server: go run ../scripts/collect_go_licenses.go ../dist/licenses/go
// Collect original notices for modules in the server build graph, plus Go notices.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

type module struct {
	Path    string
	Version string
	Dir     string
	Main    bool
	Replace *module
}
type buildPackage struct{ Module *module }
type notice struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	SHA256 string `json:"sha256"`
}
type record struct {
	Module  string   `json:"module"`
	Version string   `json:"version"`
	Files   []notice `json:"files"`
}
type goLicenseFallback struct {
	RuntimeVersion string `json:"runtimeVersion"`
	File           string `json:"file"`
	Source         string `json:"source"`
	SHA256         string `json:"sha256"`
}

var pattern = regexp.MustCompile(`(?i)^(licen[sc]e|copying|notice|copyright)([._ -].*)?$`)
var safeName = regexp.MustCompile(`[^a-zA-Z0-9_.@-]`)
var sourceExtensions = map[string]bool{".go": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".map": true, ".c": true, ".cc": true, ".cpp": true, ".h": true, ".hpp": true, ".py": true, ".rs": true, ".wasm": true, ".node": true}

func fail(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func collect(root, name, version, output string) record {
	r := record{Module: name, Version: version, Files: []notice{}}
	destination := filepath.Join(output, safeName.ReplaceAllString(name+"@"+version, "_"))
	fail(os.MkdirAll(destination, 0755))
	targets := map[string]string{}
	fail(filepath.WalkDir(root, func(file string, item os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		depth := strings.Count(filepath.ToSlash(relative), "/")
		if item.IsDir() {
			if depth >= 12 || item.Name() == ".git" || item.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !item.Type().IsRegular() || !pattern.MatchString(item.Name()) || sourceExtensions[strings.ToLower(filepath.Ext(item.Name()))] {
			return nil
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		targetName := safeName.ReplaceAllString(relative, "_")
		if previous, exists := targets[targetName]; exists && previous != relative {
			return fmt.Errorf("notice output collision in %s: %s and %s", name, previous, relative)
		}
		targets[targetName] = relative
		target := filepath.Join(destination, targetName)
		if err := os.WriteFile(target, data, 0644); err != nil {
			return err
		}
		hash := sha256.Sum256(data)
		out, err := filepath.Rel(output, target)
		if err != nil {
			return err
		}
		r.Files = append(r.Files, notice{Path: filepath.ToSlash(out), Source: filepath.ToSlash(relative), SHA256: hex.EncodeToString(hash[:])})
		return nil
	}))
	sort.Slice(r.Files, func(i, j int) bool { return r.Files[i].Source < r.Files[j].Source })
	return r
}

// Some packaged Go distributions omit GOROOT/LICENSE. Retain the exact original
// from the matching official release without modifying the installed toolchain.
func ensureGoLicense(r *record, goRoot, fallbackRoot, version, output string) error {
	info, err := os.Lstat(filepath.Join(goRoot, "LICENSE"))
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("Go distribution LICENSE must be a nonempty regular file")
		}
		for _, file := range r.Files {
			if file.Source == "LICENSE" {
				return nil
			}
		}
		return fmt.Errorf("Go distribution LICENSE was not collected")
	}
	if !os.IsNotExist(err) {
		return err
	}
	data, err := os.ReadFile(filepath.Join(fallbackRoot, "manifest.json"))
	if err != nil {
		return fmt.Errorf("Go distribution LICENSE is missing and its verified fallback is unavailable: %w", err)
	}
	var fallback goLicenseFallback
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fallback); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("Go license fallback manifest must contain one JSON object")
	}
	if fallback.RuntimeVersion != version || fallback.File != "LICENSE" ||
		fallback.Source != "https://raw.githubusercontent.com/golang/go/"+version+"/LICENSE" ||
		!regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(fallback.SHA256) {
		return fmt.Errorf("Go license fallback must match the exact runtime version, official tag and SHA-256")
	}
	path := filepath.Join(fallbackRoot, fallback.File)
	info, err = os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("Go license fallback must be a nonempty regular file")
	}
	data, err = os.ReadFile(path)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != fallback.SHA256 {
		return fmt.Errorf("Go license fallback SHA-256 mismatch")
	}
	relative := filepath.Join(safeName.ReplaceAllString("go@"+version, "_"), "LICENSE")
	if err := os.MkdirAll(filepath.Join(output, filepath.Dir(relative)), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(output, relative), data, 0644); err != nil {
		return err
	}
	r.Files = append(r.Files, notice{Path: filepath.ToSlash(relative), Source: fallback.Source, SHA256: fallback.SHA256})
	sort.Slice(r.Files, func(i, j int) bool { return r.Files[i].Source < r.Files[j].Source })
	return nil
}

func main() {
	if len(os.Args) != 2 {
		fail(fmt.Errorf("usage: go run ../scripts/collect_go_licenses.go OUTPUT"))
	}
	output, err := filepath.Abs(os.Args[1])
	fail(err)
	fail(os.MkdirAll(output, 0755))
	goBinary := os.Getenv("LINGSHU_GO")
	if goBinary == "" {
		name := "go"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		goBinary = filepath.Join(runtime.GOROOT(), "bin", name)
	}
	// Building the server downloads its package graph, not necessarily test-only modules.
	command := exec.Command(goBinary, "list", "-buildvcs=false", "-deps", "-json", "./cmd/lingshu-home")
	data, err := command.Output()
	if err != nil {
		fail(fmt.Errorf("enumerate server dependencies with %s: %w", goBinary, err))
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	modules := map[string]module{}
	for {
		var p buildPackage
		err := decoder.Decode(&p)
		if err == io.EOF {
			break
		}
		fail(err)
		if p.Module == nil || p.Module.Main {
			continue
		}
		m := *p.Module
		if m.Replace != nil {
			m = *m.Replace
		}
		if m.Dir == "" {
			fail(fmt.Errorf("module %s is unavailable; build the server with this toolchain first", m.Path))
		}
		key := m.Path + "@" + m.Version
		if previous, exists := modules[key]; exists && previous.Dir != m.Dir {
			fail(fmt.Errorf("module %s resolves to multiple source directories", key))
		}
		modules[key] = m
	}
	records := []record{}
	destinations := map[string]string{}
	for key, m := range modules {
		directory := safeName.ReplaceAllString(key, "_")
		if previous, exists := destinations[directory]; exists && previous != key {
			fail(fmt.Errorf("module notice directory collision: %s and %s", previous, key))
		}
		destinations[directory] = key
		records = append(records, collect(m.Dir, m.Path, m.Version, output))
	}
	// Go notices are a conservative superset: some toolchain code is not linked into Home.
	goNotices := collect(runtime.GOROOT(), "go", runtime.Version(), output)
	fail(ensureGoLicense(&goNotices, runtime.GOROOT(), filepath.Join("..", "assets", "licenses", "go"), runtime.Version(), output))
	records = append(records, goNotices)
	sort.Slice(records, func(i, j int) bool { return records[i].Module < records[j].Module })
	manifest, err := json.MarshalIndent(struct {
		Scope     string   `json:"scope"`
		GoVersion string   `json:"goVersion"`
		Modules   []record `json:"modules"`
	}{
		Scope: "Modules in go list -deps ./cmd/lingshu-home (main module excluded), plus original Go distribution and vendor notices. If GOROOT/LICENSE is missing, its fallback must match the official Go version and SHA-256. Go notices may include toolchain components not linked into the server binary.", GoVersion: runtime.Version(), Modules: records,
	}, "", "  ")
	fail(err)
	fail(os.WriteFile(filepath.Join(output, "manifest.json"), append(manifest, '\n'), 0644))
	missing := []string{}
	for _, r := range records {
		if len(r.Files) == 0 {
			missing = append(missing, r.Module+"@"+r.Version)
		}
	}
	fmt.Printf("Collected Go notices: %d/%d modules\n", len(records)-len(missing), len(records))
	if len(missing) > 0 {
		fail(fmt.Errorf("missing upstream notices: %s", strings.Join(missing, ", ")))
	}
}
