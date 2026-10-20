package home

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// Templates choose a bundled renderer. They never supply executable code,
// upstream credentials, or an authority to contact a new data source.
type ComponentTemplate struct {
	Format          string `json:"format"`
	ManifestVersion int    `json:"manifestVersion"`
	ID              string `json:"id"`
	Version         string `json:"version"`
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	License         string `json:"license"`
	Homepage        string `json:"homepage,omitempty"`
	Renderer        string `json:"renderer"`
	DataSchema      struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	} `json:"dataSchema"`
	Settings map[string]any `json:"settings"`
	Layout   struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"layout"`
}

type componentTemplatePreview struct {
	Manifest  ComponentTemplate `json:"manifest"`
	SHA256    string            `json:"sha256"`
	SourceURL string            `json:"sourceUrl,omitempty"`
}

var componentTemplateID = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,127}$`)
var componentTemplateVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$`)

func componentTemplateSchema(renderer string) (schema, input string) {
	switch renderer {
	case "builtin/navigation", "builtin/favorites":
		return "navigation.collection", "collection"
	case "builtin/github-traffic":
		return "github.traffic", "traffic"
	case "builtin/calendar":
		return "calendar.events", "events"
	case "builtin/weather":
		return "weather.forecast", "weather"
	case "builtin/metrics":
		return "metrics.summary", "metrics"
	case "builtin/status":
		return "status.collection", "status"
	}
	return "", ""
}

func validateComponentTemplateReference(raw any) error {
	ref, ok := object(raw)
	if !ok || !keysOnly(ref, "id", "version", "sha256", "sourceUrl") {
		return invalid("Invalid component template reference.")
	}
	id, idOK := ref["id"].(string)
	version, versionOK := ref["version"].(string)
	digest, digestOK := ref["sha256"].(string)
	if !idOK || !versionOK || !digestOK || !componentTemplateID.MatchString(id) || !componentTemplateVersion.MatchString(version) || !iconDigestPattern.MatchString(digest) {
		return invalid("A component template reference requires an ID, version and SHA-256.")
	}
	if rawURL, exists := ref["sourceUrl"]; exists {
		value, ok := rawURL.(string)
		if !ok || value == "" {
			return invalid("Invalid component template source URL.")
		}
		if _, err := iconRemoteURL(value); err != nil {
			return invalid("A component template source must be a public HTTP or HTTPS URL.")
		}
	}
	return nil
}

func parseComponentTemplate(raw []byte) (ComponentTemplate, error) {
	var manifest ComponentTemplate
	if len(raw) == 0 || len(raw) > 64<<10 {
		return manifest, invalid("A component template must contain at most 64 KiB of JSON.")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, invalid("Invalid component template JSON or unsupported fields.")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return manifest, invalid("A component template must contain exactly one JSON object.")
	}
	if manifest.Format != "lingshu-home-component" || manifest.ManifestVersion != 1 {
		return manifest, invalid("Only lingshu-home-component manifestVersion 1 is supported.")
	}
	if !componentTemplateID.MatchString(manifest.ID) || !componentTemplateVersion.MatchString(manifest.Version) {
		return manifest, invalid("Invalid component template ID or version.")
	}
	for _, field := range []struct {
		value, name string
		maximum     int
	}{
		{manifest.Name, "template name", 80}, {manifest.License, "template license", 128},
	} {
		if _, err := required(field.value, field.name, field.maximum); err != nil {
			return manifest, err
		}
	}
	if err := bounded(manifest.Description, "template description", 500); err != nil {
		return manifest, err
	}
	if manifest.Homepage != "" {
		if _, err := canonicalURL(manifest.Homepage); err != nil {
			return manifest, invalid("Invalid template homepage URL.")
		}
	}
	schema, input := componentTemplateSchema(manifest.Renderer)
	if schema == "" || manifest.DataSchema.ID != schema || manifest.DataSchema.Version != 1 {
		return manifest, invalid("The template renderer or its data schema is not supported.")
	}
	if manifest.Settings == nil {
		return manifest, invalid("Template settings must be an object.")
	}
	if manifest.Layout.Width < 4 || manifest.Layout.Width > 24 || manifest.Layout.Height < 3 || manifest.Layout.Height > 50 {
		return manifest, invalid("Template layout requires width 4–24 and height 3–50.")
	}
	// The normal page validator remains the single authority for settings.
	config := defaultPageConfig()
	config["bindings"] = map[string]any{"template-data": map[string]any{
		"datasetId": "local-navigation", "space": "current-page-space", "query": map[string]any{},
	}}
	config["views"] = []any{map[string]any{
		"id": "template-preview", "panel": map[string]any{"id": manifest.Renderer},
		"inputs": map[string]any{input: "template-data"}, "settings": manifest.Settings,
	}}
	config["layout"] = map[string]any{
		"mode": "regions-grid", "gap": 16, "grid": map[string]any{"columns": 24},
		"placements": map[string]any{"template-preview": map[string]any{
			"base": map[string]any{"kind": "grid", "region": "main", "x": 0, "y": 0,
				"w": manifest.Layout.Width, "h": manifest.Layout.Height, "heightMode": "content", "locked": false},
		}},
	}
	if err := validatePageConfig(config); err != nil {
		return manifest, err
	}
	return manifest, nil
}

func componentTemplateDigest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// Discovery is opt-in. No HTML, scripts, styles or assets are ever rendered.
func componentTemplateLink(body []byte, page *url.URL) (*url.URL, error) {
	tokens := html.NewTokenizer(bytes.NewReader(body))
	for count := 0; count < 4096; count++ {
		kind := tokens.Next()
		if kind == html.ErrorToken {
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
		var relation, href string
		for _, attribute := range tag.Attr {
			switch attribute.Key {
			case "rel":
				relation = attribute.Val
			case "href":
				href = attribute.Val
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
			return nil, invalid("Invalid component template discovery link.")
		}
		target, err := iconRemoteURL(page.ResolveReference(reference).String())
		if err != nil {
			return nil, invalid("A component template discovery link must use a public HTTP or HTTPS URL.")
		}
		return target, nil
	}
	return nil, invalid("This page does not advertise a Home component template. Use a template JSON URL or import a JSON file.")
}

func fetchComponentTemplate(ctx context.Context, client *http.Client, rawURL string) (componentTemplatePreview, error) {
	var result componentTemplatePreview
	target, err := iconRemoteURL(rawURL)
	if err != nil {
		return result, invalid("Use a public HTTP or HTTPS component template URL on a standard port.")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	requests := 0
	for discovery := 0; discovery < 2; discovery++ {
		body, final, isHTML, err := readComponentTemplateDocument(ctx, client, target, &requests, discovery == 0)
		if err != nil {
			return result, err
		}
		target = final
		if isHTML {
			target, err = componentTemplateLink(body, target)
			if err != nil {
				return result, err
			}
			continue
		}
		manifest, err := parseComponentTemplate(body)
		if err != nil {
			return result, err
		}
		return componentTemplatePreview{Manifest: manifest, SHA256: componentTemplateDigest(body), SourceURL: target.String()}, nil
	}
	return result, invalid("No component template JSON was found.")
}

func (a *App) registerComponentTemplateRoutes() {
	a.mux.HandleFunc("POST /api/v1/spaces/{spaceId}/component-templates/discover", a.serveComponentTemplateDiscovery)
	a.mux.HandleFunc("POST /api/v1/spaces/{spaceId}/component-templates/preview", a.serveComponentTemplatePreview)
	a.route("GET /api/v1/starter-packs", false, a.listStarterPacks)
}

func (a *App) componentTemplateRequest(w http.ResponseWriter, h *http.Request, q Queryer) (*Request, error) {
	r, err := a.iconHTTPContext(w, h, q)
	if err == nil {
		err = r.requireAction("pages:write")
	}
	if err == nil {
		_, err = r.requireSpace(r.param("spaceId"), true)
	}
	return r, err
}

func (a *App) serveComponentTemplatePreview(w http.ResponseWriter, h *http.Request) {
	h.Body = http.MaxBytesReader(w, h.Body, 128<<10)
	tx, err := a.store.DB.BeginTx(h.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	r, err := a.componentTemplateRequest(w, h, tx)
	var input struct {
		URL      string          `json:"url"`
		Manifest json.RawMessage `json:"manifest"`
	}
	if err == nil {
		err = r.decode(&input)
	}
	_ = tx.Rollback()
	if err != nil {
		writeError(w, err)
		return
	}
	if (input.URL == "") == (len(input.Manifest) == 0) {
		writeError(w, invalid("Supply exactly one template URL or manifest object."))
		return
	}
	var result componentTemplatePreview
	if input.URL == "" {
		result.Manifest, err = parseComponentTemplate(input.Manifest)
		result.SHA256 = componentTemplateDigest(input.Manifest)
	} else {
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
		result, err = fetchComponentTemplate(ctx, a.iconHTTPClient, input.URL)
		if err != nil {
			if networkErr := a.checkNetworkOperation(ctx, a.store.DB); networkErr != nil {
				err = networkErr
			}
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	// A mode, credential or space can change while the remote server responds.
	// Recheck before returning data; no database transaction spans networking.
	if err = a.store.CheckLease(h.Context()); err != nil {
		writeError(w, err)
		return
	}
	tx, err = a.store.DB.BeginTx(h.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = a.componentTemplateRequest(w, h, tx); err != nil {
		writeError(w, err)
		return
	}
	if err = a.checkNetworkOperation(h.Context(), tx); err != nil {
		writeError(w, err)
		return
	}
	writeIconJSON(w, http.StatusOK, result)
}
