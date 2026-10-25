package home

import (
	"bytes"
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type componentTemplateCandidate struct {
	URL   string `json:"url"`
	Title string `json:"title,omitempty"`
}

type componentTemplateDiscovery struct {
	SourceURL string                       `json:"sourceUrl"`
	Templates []componentTemplateCandidate `json:"templates"`
	Truncated bool                         `json:"truncated"`
	Preview   *componentTemplatePreview    `json:"preview,omitempty"`
}

// Discovery returns declarations for a user to select. It does not fetch every
// advertised template, execute scripts, or contact data sources.
func componentTemplateCandidates(body []byte, page *url.URL) ([]componentTemplateCandidate, bool, error) {
	return scopedComponentTemplateCandidates(iconNetworkContext(context.Background(), page), body, page)
}

func scopedComponentTemplateCandidates(ctx context.Context, body []byte, page *url.URL) ([]componentTemplateCandidate, bool, error) {
	result := []componentTemplateCandidate{}
	seen := map[string]bool{}
	tokens := html.NewTokenizer(bytes.NewReader(body))
	truncated := len(body) >= 128<<10
	for count := 0; ; count++ {
		if count >= 4096 {
			truncated = true
			break
		}
		kind := tokens.Next()
		if kind == html.ErrorToken {
			break
		}
		if kind == html.EndTagToken && tokens.Token().Data == "head" {
			break
		}
		if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
			continue
		}
		tag := tokens.Token()
		if tag.Data == "body" {
			break
		}
		if tag.Data != "link" {
			continue
		}
		var relation, href, title string
		for _, attr := range tag.Attr {
			switch attr.Key {
			case "rel":
				relation = attr.Val
			case "href":
				href = attr.Val
			case "title":
				title = attr.Val
			}
		}
		match := false
		for _, rel := range strings.Fields(strings.ToLower(relation)) {
			match = match || rel == "lingshu-home-component"
		}
		if !match || href == "" {
			continue
		}
		reference, err := url.Parse(href)
		if err != nil {
			return nil, false, invalid("Invalid component template discovery link.")
		}
		target, err := iconScopedRemoteURL(ctx, page.ResolveReference(reference).String())
		if err != nil {
			return nil, false, invalid("A component template discovery link must stay within the permitted network scope.")
		}
		canonical := target.String()
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		if len(result) == 8 {
			truncated = true
			break
		}
		title = strings.Join(strings.Fields(title), " ")
		if chars := []rune(title); len(chars) > 80 {
			title = string(chars[:80])
		}
		result = append(result, componentTemplateCandidate{URL: canonical, Title: title})
	}
	if len(result) == 0 {
		return nil, truncated, invalid("This page does not advertise a Home component template. Use a template JSON URL or import a JSON file.")
	}
	return result, truncated, nil
}

// Both legacy single-template preview and multi-template discovery use the same
// bounded request/redirect implementation and outbound network policy.
func readComponentTemplateDocument(ctx context.Context, client *http.Client, target *url.URL, requests *int, allowHTML bool) ([]byte, *url.URL, bool, error) {
	for {
		checked, err := iconScopedRemoteURL(ctx, target.String())
		if err != nil {
			return nil, target, false, err
		}
		target = checked
		if *requests >= 5 {
			return nil, target, false, invalid("The component template request or redirect limit was reached.")
		}
		(*requests)++
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, target, false, invalid("Invalid component template URL.")
		}
		request.Header.Set("Accept", "application/json,text/html;q=0.8,text/plain;q=0.5")
		request.Header.Set("User-Agent", "Lingshu-Home/component-template")
		response, err := client.Do(request)
		if err != nil {
			return nil, target, false, invalid("The component template could not be fetched.")
		}
		if response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 || response.StatusCode == 307 || response.StatusCode == 308 {
			location := response.Header.Get("Location")
			response.Body.Close()
			next, err := url.Parse(location)
			if err != nil || location == "" {
				return nil, target, false, invalid("Invalid component template redirect.")
			}
			target, err = iconScopedRemoteURL(ctx, target.ResolveReference(next).String())
			if err != nil {
				return nil, target, false, invalid("A component template redirect must stay within the permitted network scope.")
			}
			continue
		}
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Encoding") != "" {
			response.Body.Close()
			return nil, target, false, invalid("The component template returned an unsupported response.")
		}
		mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		isHTML := mediaType == "text/html" || mediaType == "application/xhtml+xml"
		if isHTML {
			if !allowHTML {
				response.Body.Close()
				return nil, target, true, invalid("The discovery link must point directly to component template JSON.")
			}
			body := readIconHTMLHead(response.Body, 128<<10)
			response.Body.Close()
			return body, target, true, nil
		}
		if response.ContentLength > 64<<10 {
			response.Body.Close()
			return nil, target, false, invalid("The component template exceeds 64 KiB.")
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
		response.Body.Close()
		if err != nil || len(body) > 64<<10 {
			return nil, target, false, invalid("The component template exceeds 64 KiB or is incomplete.")
		}
		return body, target, false, nil
	}
}

func discoverComponentTemplates(ctx context.Context, client *http.Client, rawURL string) (componentTemplateDiscovery, error) {
	result := componentTemplateDiscovery{Templates: []componentTemplateCandidate{}}
	target, err := iconRemoteURL(rawURL)
	if err != nil {
		return result, invalid("Use a permitted HTTP or HTTPS component template URL.")
	}
	ctx = iconNetworkContext(ctx, target)
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	requests := 0
	body, target, isHTML, err := readComponentTemplateDocument(ctx, client, target, &requests, true)
	if err != nil {
		return result, err
	}
	result.SourceURL = target.String()
	if isHTML {
		result.Templates, result.Truncated, err = scopedComponentTemplateCandidates(ctx, body, target)
		return result, err
	}
	manifest, err := parseComponentTemplate(body)
	if err != nil {
		return result, err
	}
	result.Preview = &componentTemplatePreview{Manifest: manifest, SHA256: componentTemplateDigest(body), SourceURL: target.String()}
	return result, nil
}

func (a *App) serveComponentTemplateDiscovery(w http.ResponseWriter, h *http.Request) {
	h.Body = http.MaxBytesReader(w, h.Body, 16<<10)
	tx, err := a.store.DB.BeginTx(h.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	r, err := a.componentTemplateRequest(w, h, tx)
	var input struct {
		URL string `json:"url"`
	}
	if err == nil {
		err = r.decode(&input)
	}
	_ = tx.Rollback()
	if err != nil {
		writeError(w, err)
		return
	}
	select {
	case a.iconFetchGate <- struct{}{}:
		defer func() { <-a.iconFetchGate }()
	default:
		writeError(w, &APIError{Status: 429, Code: "component_fetch_busy", Message: "Another asset or component template is being fetched. Try again shortly."})
		return
	}
	ctx, done := a.beginNetworkOperation(h.Context())
	defer done()
	h = h.WithContext(ctx)
	result, err := discoverComponentTemplates(ctx, a.iconHTTPClient, input.URL)
	if err != nil {
		if networkErr := a.checkNetworkOperation(ctx, a.store.DB); networkErr != nil {
			err = networkErr
		}
		writeError(w, err)
		return
	}
	if err = a.checkNetworkOperation(ctx, a.store.DB); err != nil {
		writeError(w, err)
		return
	}
	if err = a.store.CheckLease(ctx); err != nil {
		writeError(w, err)
		return
	}
	tx, err = a.store.DB.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = a.componentTemplateRequest(w, h, tx); err != nil {
		writeError(w, err)
		return
	}
	if err = a.checkNetworkOperation(ctx, tx); err != nil {
		writeError(w, err)
		return
	}
	writeIconJSON(w, http.StatusOK, result)
}
