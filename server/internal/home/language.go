package home

import (
	"bytes"
	"net/http"
	"os"
	"time"

	"golang.org/x/net/html"
)

func (a *App) localized(chinese, english string) string {
	if a.config.Language == "en" {
		return english
	}
	return chinese
}

// Change only the document element: body content and asset references must be
// byte-for-byte identical to the frontend build. Tokenizing avoids depending on
// the source template's attribute order, case, quoting, or existing language.
func documentLanguage(content []byte, language string) []byte {
	tokens := html.NewTokenizer(bytes.NewReader(content))
	offset := 0
	for {
		kind := tokens.Next()
		if kind == html.ErrorToken {
			return content
		}
		start := offset
		offset += len(tokens.Raw())
		if kind != html.StartTagToken {
			continue
		}
		tag := tokens.Token()
		if tag.Data != "html" {
			continue
		}
		attributes := make([]html.Attribute, 0, len(tag.Attr)+1)
		for _, attribute := range tag.Attr {
			if attribute.Key != "lang" {
				attributes = append(attributes, attribute)
			}
		}
		tag.Attr = append(attributes, html.Attribute{Key: "lang", Val: language})
		result := make([]byte, 0, len(content)+len(language)+8)
		result = append(result, content[:start]...)
		result = append(result, tag.String()...)
		return append(result, content[offset:]...)
	}
}

// The initial document must agree with bootstrap before any JavaScript runs.
// No Last-Modified validator is sent: switching the instance language can
// change these bytes even when the static build on disk did not change.
func (a *App) serveIndex(w http.ResponseWriter, r *http.Request, path string) {
	content, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, a.localized("请先构建前端并设置 LINGSHU_WEB_DIR。", "Build the frontend and set LINGSHU_WEB_DIR before opening Home."), http.StatusServiceUnavailable)
		return
	}
	language := a.config.Language
	if language == "" {
		language = "zh-CN"
	}
	content = documentLanguage(content, language)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Language", language)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(content))
}
