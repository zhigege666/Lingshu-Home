package home

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Only content-hashed build assets can survive an application update in a browser cache.
var immutableAssetName = regexp.MustCompile(`^/assets/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$`)

func serveStaticAsset(w http.ResponseWriter, r *http.Request, path, clean string) {
	w.Header().Set("Cache-Control", "no-cache")
	if immutableAssetName.MatchString(clean) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	ext := filepath.Ext(path)
	if ext == ".js" || ext == ".css" {
		w.Header().Add("Vary", "Accept-Encoding")
		// Range requests keep the original representation; normal requests use the build-time copy.
		if r.Header.Get("Range") == "" && acceptsGzip(r.Header.Values("Accept-Encoding")) {
			if info, err := os.Stat(path + ".gz"); err == nil && info.Mode().IsRegular() {
				w.Header().Set("Content-Type", mime.TypeByExtension(ext))
				w.Header().Set("Content-Encoding", "gzip")
				http.ServeFile(w, r, path+".gz")
				return
			}
		}
	}
	http.ServeFile(w, r, path)
}

func acceptsGzip(values []string) bool {
	explicit, wildcard := -1.0, 0.0
	for _, token := range strings.Split(strings.Join(values, ","), ",") {
		parts := strings.Split(strings.TrimSpace(token), ";")
		coding := strings.ToLower(strings.TrimSpace(parts[0]))
		if coding != "gzip" && coding != "*" {
			continue
		}
		quality := 1.0
		for _, raw := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(raw), "=")
			if !ok || !strings.EqualFold(strings.TrimSpace(key), "q") {
				quality = 0
				break
			}
			q, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || !(q >= 0 && q <= 1) {
				quality = 0
				break
			}
			quality = q
		}
		if coding == "gzip" {
			// An explicit refusal wins even if a wildcard is present.
			if explicit < 0 || quality < explicit {
				explicit = quality
			}
		} else {
			wildcard = quality
		}
	}
	if explicit >= 0 {
		return explicit > 0
	}
	return wildcard > 0
}
