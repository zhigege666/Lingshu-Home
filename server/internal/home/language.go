package home

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"golang.org/x/net/html"
)

// Language is an instance choice. Keep the running value separate from startup
// configuration so a failed transaction can never change the UI language.
func (a *App) currentLanguage() string {
	if language, ok := a.language.Load().(string); ok && language != "" {
		return language
	}
	if a.config.Language != "" {
		return a.config.Language
	}
	return "zh-CN"
}

func (a *App) initializeLanguage(ctx context.Context) error {
	settings, err := a.loadSettings(ctx, a.store.DB)
	if err != nil {
		return err
	}
	language := settings.Language
	if language == "" {
		language = a.config.Language
		if language == "" && settings.Initialized {
			// Previous versions used Chinese when startup supplied no language.
			// Preserve existing instances rather than reopening first-run setup.
			language = "zh-CN"
		}
		if language != "" {
			_, err = a.store.DB.ExecContext(ctx, a.store.Query("UPDATE settings SET language=? WHERE id=1 AND language=''"), language)
			if err != nil {
				return err
			}
		}
	} else if a.config.Language != "" && a.config.Language != language {
		log.Printf("warning: instance language is already fixed to %s; ignoring startup language %s", language, a.config.Language)
	}
	a.language.Store(language)
	return nil
}

func languageRequired() *APIError {
	return &APIError{Status: http.StatusConflict, Code: "language_required", Message: "Choose the instance language before completing setup."}
}

func languageLocked() *APIError {
	return &APIError{Status: http.StatusConflict, Code: "language_locked", Message: "The instance language has already been selected and cannot be changed."}
}

func (a *App) selectSetupLanguage(r *Request) (*Response, error) {
	if r.Bearer {
		return nil, forbidden()
	}
	var input struct {
		Language string `json:"language"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	if input.Language != "zh-CN" && input.Language != "en" {
		return nil, invalid("Unsupported language. Choose zh-CN or en.")
	}
	if r.Settings.Language != "" {
		if r.Settings.Language != input.Language {
			return nil, languageLocked()
		}
		// Repeating a confirmed choice is safe after a lost response. It never
		// changes settings, including after initialization has completed.
		return a.bootstrap(r)
	}
	if r.Settings.Initialized {
		return nil, languageLocked()
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET language=? WHERE id=1 AND language='' AND initialized=?"), input.Language, false)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed != 1 {
		return nil, languageLocked()
	}
	r.Settings.Language = input.Language
	r.LanguageUpdate = input.Language
	return a.bootstrap(r)
}

func (a *App) localized(chinese, english string) string {
	if a.currentLanguage() == "en" {
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
// No Last-Modified validator is sent: confirming the first-run language can
// change these bytes even when the static build on disk did not change.
func (a *App) serveIndex(w http.ResponseWriter, r *http.Request, path string) {
	content, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, a.localized("请先构建前端并设置 LINGSHU_WEB_DIR。", "Build the frontend and set LINGSHU_WEB_DIR before opening Home."), http.StatusServiceUnavailable)
		return
	}
	language := a.currentLanguage()
	content = documentLanguage(content, language)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Language", language)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(content))
}
