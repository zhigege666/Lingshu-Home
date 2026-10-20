package home

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticAssetCompressionAndCaching(t *testing.T) {
	dir := t.TempDir()
	asset := filepath.Join(dir, "index-abcDEF12.js")
	original := []byte(strings.Repeat("const value = 'test';\n", 200))
	if err := os.WriteFile(asset, original, 0600); err != nil {
		t.Fatal(err)
	}
	var zipped bytes.Buffer
	writer := gzip.NewWriter(&zipped)
	_, _ = writer.Write(original)
	_ = writer.Close()
	if err := os.WriteFile(asset+".gz", zipped.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, method, accept, byteRange string
		gzip                            bool
	}{
		{"gzip", "GET", "gzip, deflate", "", true},
		{"wildcard", "GET", "br, *;q=0.5", "", true},
		{"head", "HEAD", "gzip", "", true},
		{"refused", "GET", "gzip;q=0, *;q=1", "", false},
		{"malformed quality", "GET", "gzip;q=NaN", "", false},
		{"br only", "GET", "br", "", false},
		{"no header", "GET", "", "", false},
		{"range", "GET", "gzip", "bytes=0-9", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(test.method, "/assets/index-abcDEF12.js", nil)
			r.Header.Set("Accept-Encoding", test.accept)
			if test.byteRange != "" {
				r.Header.Set("Range", test.byteRange)
			}
			w := httptest.NewRecorder()
			serveStaticAsset(w, r, asset, r.URL.Path)
			if got := w.Header().Get("Content-Encoding"); (got == "gzip") != test.gzip {
				t.Fatalf("encoding=%s", got)
			}
			if w.Header().Get("Vary") != "Accept-Encoding" || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatal(w.Header())
			}
			if !strings.Contains(w.Header().Get("Content-Type"), "javascript") {
				t.Fatal(w.Header())
			}
			if test.method == "HEAD" {
				if w.Body.Len() != 0 {
					t.Fatal("HEAD returned a body")
				}
				return
			}
			body := w.Body.Bytes()
			if test.gzip {
				z, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				body, err = io.ReadAll(z)
				_ = z.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			want := original
			if test.byteRange != "" {
				want = original[:10]
				if w.Code != 206 {
					t.Fatal(w.Code)
				}
			}
			if !bytes.Equal(body, want) {
				t.Fatal("wrong representation")
			}
		})
	}
	for _, clean := range []string{"/index.html", "/icons/lucide/link.svg", "/assets/unhashed.js"} {
		r := httptest.NewRequest("GET", clean, nil)
		w := httptest.NewRecorder()
		serveStaticAsset(w, r, asset, clean)
		if w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("unversioned %s was cached", clean)
		}
	}
	if err := os.Remove(asset + ".gz"); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/assets/index-abcDEF12.js", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	serveStaticAsset(w, r, asset, r.URL.Path)
	if w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), original) {
		t.Fatal("missing sidecar must fall back to plain data")
	}
}
