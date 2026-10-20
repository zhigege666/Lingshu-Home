package home

import (
	"net/url"
	"regexp"
	"strings"
)

var navigationProbePath = regexp.MustCompile(`^/[A-Za-z0-9/_.~\-]*$`)

// Probe only an explicitly configured, same-origin read path. Never derive it
// from a bookmark's page path, query string, or fragment.
func validateEndpointRouting(endpoint *Endpoint) error {
	if endpoint.Route == "" {
		if endpoint.ProbePath != "" {
			return invalid("A probe path requires an internal or external route.")
		}
		return nil
	}
	if endpoint.Route != "internal" && endpoint.Route != "external" {
		return invalid("Endpoint route must be internal or external.")
	}
	path := endpoint.ProbePath
	if path == "" {
		return nil
	}
	if len(path) > 256 || !navigationProbePath.MatchString(path) || strings.HasPrefix(path, "//") {
		return invalid("Probe path must be a same-origin path, without credentials, query, fragment, or encoded characters.")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "." || part == ".." {
			return invalid("Probe path cannot contain dot segments.")
		}
	}
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || u.Path != path {
		return invalid("Probe path must be a same-origin path.")
	}
	return nil
}

// This narrow mutation deliberately does not round-trip access or icon settings.
func (a *App) updateNavigationSettings(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.Bearer {
		return nil, forbidden()
	}
	if r.Settings.HasOwner {
		if err := r.requireOwner(); err != nil {
			return nil, err
		}
	} else if r.Settings.Mode != ModeOpenEdit {
		return nil, forbidden()
	}
	var in struct {
		AutoSelectEndpoint optionalIconBool `json:"autoSelectEndpoint"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if !in.AutoSelectEndpoint.present {
		return nil, invalid("autoSelectEndpoint is required.")
	}
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET auto_select_endpoint=? WHERE id=1"), in.AutoSelectEndpoint.value); err != nil {
		return nil, err
	}
	r.Settings.AutoSelectEndpoint = in.AutoSelectEndpoint.value
	return ok(map[string]any{"autoSelectEndpoint": r.Settings.AutoSelectEndpoint}), nil
}
