package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var iconAssetPattern = regexp.MustCompile(`^asset:([0-9a-f]{32}):([0-9a-f]{64})$`)
var iconDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var iconKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

const iconSpaceMaxBytes = 32 << 20

type IconAsset struct {
	Ref       string `json:"ref"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}
type IconPackEntry struct {
	IconAsset
	Key          string `json:"key"`
	Label        string `json:"label"`
	SourceSHA256 string `json:"sourceSha256"`
}
type IconPack struct {
	ID        string          `json:"id"`
	SpaceID   string          `json:"spaceId"`
	Name      string          `json:"name"`
	SourceURL string          `json:"sourceUrl"`
	License   string          `json:"license"`
	CreatedAt string          `json:"createdAt"`
	Icons     []IconPackEntry `json:"icons"`
}

func iconAsset(spaceID, digest, mediaType string, width, height int) IconAsset {
	return IconAsset{Ref: "asset:" + spaceID + ":" + digest, URL: "/api/v1/spaces/" + spaceID + "/icons/" + digest, SHA256: digest, MediaType: mediaType, Width: width, Height: height}
}

func (a *App) registerIconRoutes() {
	a.route("GET /api/v1/spaces/{spaceId}/icon-packs", false, a.listIconPacks)
	a.route("POST /api/v1/spaces/{spaceId}/icon-packs", true, a.importIconPack)
	a.route("DELETE /api/v1/spaces/{spaceId}/icon-packs/{id}", true, a.deleteIconPack)
	a.route("GET /api/v1/spaces/{spaceId}/icons/{digest}", false, a.readIconAsset)
	a.mux.HandleFunc("POST /api/v1/spaces/{spaceId}/icons/fetch", a.serveFaviconFetch)
}

func (a *App) validSpaceIcon(r *Request, spaceID, value, fallback string) (string, error) {
	if !strings.HasPrefix(value, "asset:") {
		return validIcon(value, fallback)
	}
	match := iconAssetPattern.FindStringSubmatch(value)
	if match == nil || match[1] != spaceID {
		return "", invalid("An imported icon must belong to the current space.")
	}
	var exists bool
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_assets WHERE space_id=? AND digest=?)"), spaceID, match[2]).Scan(&exists)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", invalid("Import or fetch the icon in this space before using it.")
	}
	return value, nil
}

func (a *App) readIconAsset(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	digest := r.param("digest")
	if !iconDigestPattern.MatchString(digest) {
		return nil, missing()
	}
	etag := `"` + digest + `"`
	notModified := iconETagMatches(r.HTTP.Header.Values("If-None-Match"), etag)
	var body []byte
	var mediaType string
	if notModified {
		// Check that the authorized asset still exists without reading its image
		// bytes on every browser revalidation.
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT media_type FROM icon_assets WHERE space_id=? AND digest=?"), space.ID, digest).Scan(&mediaType)
	} else {
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT content,media_type FROM icon_assets WHERE space_id=? AND digest=?"), space.ID, digest).Scan(&body, &mediaType)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	// Browsers may retain bytes but must revalidate them. Both authorization and
	// existence were checked before exposing an ETag or returning 304, so logout,
	// access changes and asset removal cannot reuse a previous authorization.
	r.Writer.Header().Set("Cache-Control", "private, no-cache")
	r.Writer.Header().Set("ETag", etag)
	r.Writer.Header().Set("Vary", "Cookie, Authorization")
	r.Writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	r.Writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	if notModified {
		return &Response{Status: http.StatusNotModified}, nil
	}
	return &Response{Status: 200, Body: body, ContentType: mediaType}, nil
}

// GET If-None-Match uses weak comparison. Parse quoted tags rather than splitting
// on commas, which are also legal inside an opaque tag. Invalid conditions are
// ignored, and only a standalone wildcard matches every existing representation.
func iconETagMatches(values []string, etag string) bool {
	remaining := strings.Trim(strings.Join(values, ","), " \t")
	if remaining == "*" {
		return true
	}
	matched := false
	for remaining != "" {
		// Empty list members are harmless and accepted by HTTP list parsing.
		remaining = strings.TrimLeft(remaining, " \t,")
		if remaining == "" {
			break
		}
		if strings.HasPrefix(remaining, "W/") {
			remaining = remaining[2:]
		}
		if len(remaining) < 2 || remaining[0] != '"' {
			return false
		}
		end := 1
		for end < len(remaining) && remaining[end] != '"' {
			c := remaining[end]
			if c < 0x21 || c == 0x7f {
				return false
			}
			end++
		}
		if end == len(remaining) {
			return false
		}
		matched = matched || remaining[:end+1] == etag
		remaining = strings.TrimLeft(remaining[end+1:], " \t")
		if remaining != "" && remaining[0] != ',' {
			return false
		}
	}
	return matched
}

func (a *App) readIconPacks(r *Request, spaceID string) ([]IconPack, error) {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,name,source_url,license,created_at FROM icon_packs WHERE space_id=? ORDER BY created_at,id"), spaceID)
	if err != nil {
		return nil, err
	}
	packs := []IconPack{}
	for rows.Next() {
		pack := IconPack{SpaceID: spaceID, Icons: []IconPackEntry{}}
		var created databaseTime
		if err = rows.Scan(&pack.ID, &pack.Name, &pack.SourceURL, &pack.License, &created); err != nil {
			rows.Close()
			return nil, err
		}
		pack.CreatedAt = created.String()
		packs = append(packs, pack)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range packs {
		entries, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT e.icon_key,e.label,e.source_sha256,a.digest,a.media_type,a.width,a.height FROM icon_pack_entries e JOIN icon_assets a ON a.space_id=e.space_id AND a.digest=e.digest WHERE e.space_id=? AND e.pack_id=? ORDER BY e.icon_key"), spaceID, packs[i].ID)
		if err != nil {
			return nil, err
		}
		for entries.Next() {
			var entry IconPackEntry
			if err = entries.Scan(&entry.Key, &entry.Label, &entry.SourceSHA256, &entry.SHA256, &entry.MediaType, &entry.Width, &entry.Height); err != nil {
				entries.Close()
				return nil, err
			}
			entry.IconAsset = iconAsset(spaceID, entry.SHA256, entry.MediaType, entry.Width, entry.Height)
			packs[i].Icons = append(packs[i].Icons, entry)
		}
		err = entries.Err()
		entries.Close()
		if err != nil {
			return nil, err
		}
	}
	return packs, nil
}

func (a *App) listIconPacks(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	packs, err := a.readIconPacks(r, space.ID)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"packs": packs}), nil
}

func (a *App) insertIconAsset(r *Request, spaceID string, icon normalizedIcon) error {
	var exists bool
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_assets WHERE space_id=? AND digest=?)"), spaceID, icon.Digest).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	var count, total int64
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*),COALESCE(SUM(length(content)),0) FROM icon_assets WHERE space_id=?"), spaceID).Scan(&count, &total); err != nil {
		return err
	}
	if count >= 1024 || total+int64(len(icon.Content)) > iconSpaceMaxBytes {
		return invalid("A space can retain at most 1024 custom icons and 32 MiB of image content.")
	}
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO icon_assets(space_id,digest,media_type,content,width,height,created_at) VALUES(?,?,?,?,?,?,?)"), spaceID, icon.Digest, icon.MediaType, icon.Content, icon.Width, icon.Height, nowUTC())
	return err
}

func (a *App) importIconPack(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in struct {
		SchemaVersion int    `json:"schemaVersion"`
		Name          string `json:"name"`
		SourceURL     string `json:"sourceUrl"`
		License       string `json:"license"`
		Icons         []struct {
			Key        string `json:"key"`
			Label      string `json:"label"`
			MediaType  string `json:"mediaType"`
			DataBase64 string `json:"dataBase64"`
		} `json:"icons"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.SchemaVersion != 1 || len(in.Icons) == 0 || len(in.Icons) > 64 {
		return nil, invalid("An icon pack requires schemaVersion 1 and 1 to 64 icons.")
	}
	name, err := required(in.Name, "Icon pack name", 80)
	if err != nil {
		return nil, err
	}
	license, err := required(in.License, "Icon license or ownership notice", 2048)
	if err != nil {
		return nil, err
	}
	sourceURL := ""
	if in.SourceURL != "" {
		sourceURL, err = canonicalURL(in.SourceURL)
		if err != nil {
			return nil, err
		}
	}
	var count int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM icon_packs WHERE space_id=?"), space.ID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= 32 {
		return nil, invalid("A space may contain at most 32 imported icon packs.")
	}
	pack := IconPack{ID: newID(), SpaceID: space.ID, Name: name, SourceURL: sourceURL, License: license, CreatedAt: nowUTC(), Icons: []IconPackEntry{}}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO icon_packs(id,space_id,name,source_url,license,created_at) VALUES(?,?,?,?,?,?)"), pack.ID, space.ID, pack.Name, pack.SourceURL, pack.License, pack.CreatedAt)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	total := 0
	for _, item := range in.Icons {
		if !iconKeyPattern.MatchString(item.Key) || seen[item.Key] {
			return nil, invalid("Icon keys must be unique lowercase names of at most 64 characters.")
		}
		seen[item.Key] = true
		label, err := required(item.Label, "Icon label", 80)
		if err != nil {
			return nil, err
		}
		if len(item.DataBase64) > base64.StdEncoding.EncodedLen(iconMaxBytes) {
			return nil, invalid("Each encoded icon exceeds the 256 KiB limit.")
		}
		body, err := base64.StdEncoding.Strict().DecodeString(item.DataBase64)
		if err != nil {
			return nil, invalid("Icon content must be standard base64 without a data URL prefix.")
		}
		total += len(body)
		if total > 4<<20 {
			return nil, invalid("An icon pack may contain at most 4 MiB of decoded images.")
		}
		icon, err := normalizeIcon(body, item.MediaType)
		if err != nil {
			return nil, err
		}
		if err = a.insertIconAsset(r, space.ID, icon); err != nil {
			return nil, err
		}
		digest := sha256.Sum256(body)
		entry := IconPackEntry{IconAsset: iconAsset(space.ID, icon.Digest, icon.MediaType, icon.Width, icon.Height), Key: item.Key, Label: label, SourceSHA256: hex.EncodeToString(digest[:])}
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO icon_pack_entries(pack_id,space_id,icon_key,label,digest,source_sha256) VALUES(?,?,?,?,?,?)"), pack.ID, space.ID, entry.Key, entry.Label, entry.SHA256, entry.SourceSHA256)
		if err != nil {
			return nil, err
		}
		pack.Icons = append(pack.Icons, entry)
	}
	return &Response{Status: 201, Data: pack}, nil
}

func iconContainsReference(value any, ref string) bool {
	switch v := value.(type) {
	case string:
		return v == ref
	case []any:
		for _, entry := range v {
			if iconContainsReference(entry, ref) {
				return true
			}
		}
	case map[string]any:
		for _, entry := range v {
			if iconContainsReference(entry, ref) {
				return true
			}
		}
	}
	return false
}

func (a *App) iconReferenced(r *Request, spaceID, ref string) (bool, error) {
	var exists bool
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM links WHERE space_id=? AND icon=?) OR EXISTS(SELECT 1 FROM categories WHERE space_id=? AND icon=?)"), spaceID, ref, spaceID, ref).Scan(&exists)
	if err != nil || exists {
		return exists, err
	}
	for _, statement := range []string{"SELECT config FROM pages WHERE space_id=?", "SELECT s.data_json FROM integration_snapshots s JOIN integration_sources i ON i.id=s.source_id WHERE i.space_id=?"} {
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query(statement), spaceID)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var raw []byte
			var data any
			if err = rows.Scan(&raw); err == nil {
				err = json.Unmarshal(raw, &data)
			}
			if err != nil {
				rows.Close()
				return false, err
			}
			if iconContainsReference(data, ref) {
				rows.Close()
				return true, nil
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return false, err
		}
	}
	return false, nil
}

func (a *App) deleteIconPack(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	id := r.param("id")
	if !validID(id) {
		return nil, missing()
	}
	var exists bool
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_packs WHERE space_id=? AND id=?)"), space.ID, id).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, missing()
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT DISTINCT digest FROM icon_pack_entries WHERE space_id=? AND pack_id=?"), space.ID, id)
	if err != nil {
		return nil, err
	}
	digests := []string{}
	for rows.Next() {
		var digest string
		if err = rows.Scan(&digest); err != nil {
			rows.Close()
			return nil, err
		}
		digests = append(digests, digest)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	remove := []string{}
	for _, digest := range digests {
		var retained bool
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_pack_entries WHERE space_id=? AND digest=? AND pack_id<>?) OR EXISTS(SELECT 1 FROM icon_favicon_cache WHERE space_id=? AND digest=?)"), space.ID, digest, id, space.ID, digest).Scan(&retained)
		if err != nil {
			return nil, err
		}
		if retained {
			continue
		}
		used, err := a.iconReferenced(r, space.ID, "asset:"+space.ID+":"+digest)
		if err != nil {
			return nil, err
		}
		if used {
			return nil, conflict("Replace icons used by links, categories, pages or source snapshots before deleting this pack.")
		}
		remove = append(remove, digest)
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM icon_packs WHERE space_id=? AND id=?"), space.ID, id)
	if err != nil {
		return nil, err
	}
	for _, digest := range remove {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM icon_assets WHERE space_id=? AND digest=?"), space.ID, digest); err != nil {
			return nil, err
		}
	}
	return &Response{Status: 204}, nil
}

type iconFetchResponse struct {
	IconAsset
	Cached    bool   `json:"cached"`
	Stale     bool   `json:"stale"`
	SourceURL string `json:"sourceUrl"`
}

// Favicon networking happens between two short authorized transactions. This
// helper deliberately mirrors the router's authentication rules, including
// rejecting duplicate/malformed Authorization rather than falling back to a
// cookie and preserving open_edit's authorized anonymous maintenance.
func (a *App) iconHTTPContext(w http.ResponseWriter, h *http.Request, q Queryer) (*Request, error) {
	r := &Request{App: a, HTTP: h, Writer: w, Q: q}
	var err error
	r.Settings, err = a.loadSettings(h.Context(), q)
	if err != nil {
		return nil, err
	}
	values := h.Header.Values("Authorization")
	if len(values) > 0 {
		auth := h.Header.Get("Authorization")
		if len(values) != 1 || len(auth) < 8 || !strings.EqualFold(auth[:7], "Bearer ") {
			return nil, unauthorized()
		}
		err = a.authenticateBearer(r, strings.TrimSpace(auth[7:]))
	} else {
		err = a.authenticateCookie(r)
	}
	if err == nil {
		err = a.checkCSRF(r)
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (a *App) cachedWebsiteIcon(r *Request, spaceID, origin string) (*iconFetchResponse, bool, error) {
	var digest sql.NullString
	var source, lastError string
	var retry databaseTime
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT digest,source_url,retry_at,last_error FROM icon_favicon_cache WHERE space_id=? AND origin=?"), spaceID, origin).Scan(&digest, &source, &retry, &lastError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !retry.After(time.Now()) {
		return nil, false, nil
	}
	if !digest.Valid {
		return nil, true, &APIError{Status: 422, Code: "favicon_unavailable", Message: "No supported website icon was found recently. Retry after the cache expires or import an image."}
	}
	var mediaType string
	var width, height int
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT media_type,width,height FROM icon_assets WHERE space_id=? AND digest=?"), spaceID, digest.String).Scan(&mediaType, &width, &height)
	if err != nil {
		return nil, true, err
	}
	return &iconFetchResponse{IconAsset: iconAsset(spaceID, digest.String, mediaType, width, height), Cached: true, Stale: lastError != "", SourceURL: source}, true, nil
}

func writeIconJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *App) serveFaviconFetch(w http.ResponseWriter, h *http.Request) {
	h.Body = http.MaxBytesReader(w, h.Body, 8192)
	tx, err := a.store.DB.BeginTx(h.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	r, err := a.iconHTTPContext(w, h, tx)
	var space *Space
	if err == nil {
		space, err = r.navigationSpace(r.param("spaceId"), true)
	}
	var in struct {
		URL string `json:"url"`
	}
	if err == nil {
		err = r.decode(&in)
	}
	var origin string
	if err == nil {
		target, e := iconWebsiteOrigin(in.URL)
		err = e
		if target != nil {
			origin = target.String()
		}
	}
	var cached *iconFetchResponse
	var fresh bool
	if err == nil {
		cached, fresh, err = a.cachedWebsiteIcon(r, space.ID, origin)
	}
	if err == nil && !fresh {
		var allowed bool
		allowed, err = a.iconOriginAdmission(r, space.ID, origin)
		if err == nil && !allowed {
			err = invalid("The space's website icon cache or image storage is full.")
		}
	}
	_ = tx.Rollback()
	if err != nil {
		writeError(w, err)
		return
	}
	if fresh {
		writeIconJSON(w, 200, cached)
		return
	}
	select {
	case a.iconFetchGate <- struct{}{}:
		defer func() { <-a.iconFetchGate }()
	default:
		writeError(w, &APIError{Status: 429, Code: "icon_fetch_busy", Message: "A website icon is being fetched. Try again shortly."})
		return
	}
	// A queued automatic task may have completed between the first cache read
	// and acquiring the shared gate. Recheck before performing any networking.
	tx, err = a.store.DB.BeginTx(h.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	r, err = a.iconHTTPContext(w, h, tx)
	if err == nil {
		space, err = r.navigationSpace(r.param("spaceId"), true)
	}
	if err == nil {
		cached, fresh, err = a.cachedWebsiteIcon(r, space.ID, origin)
	}
	_ = tx.Rollback()
	if err != nil {
		writeError(w, err)
		return
	}
	if fresh {
		writeIconJSON(w, 200, cached)
		return
	}
	target, _ := iconWebsiteOrigin(origin)
	ctx, done := a.beginNetworkOperation(h.Context())
	defer done()
	h = h.WithContext(ctx)
	icon, sourceURL, fetchErr := fetchWebsiteIcon(h.Context(), a.iconHTTPClient, target)
	if errors.Is(context.Cause(ctx), errNetworkProxyChanged) {
		writeError(w, networkProxyChanged())
		return
	}
	// Recheck identity, mode, token scope, CSRF and space before storing a result.
	select {
	case a.writeGate <- struct{}{}:
		defer func() { <-a.writeGate }()
	case <-h.Context().Done():
		if errors.Is(context.Cause(ctx), errNetworkProxyChanged) {
			writeError(w, networkProxyChanged())
		}
		return
	}
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
	if err = a.checkNetworkOperation(ctx, tx); err != nil {
		writeError(w, err)
		return
	}
	r, err = a.iconHTTPContext(w, h, tx)
	if err == nil {
		space, err = r.navigationSpace(r.param("spaceId"), true)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	// Another request may already have completed a fetch for the same origin.
	if cached, fresh, err = a.cachedWebsiteIcon(r, space.ID, origin); fresh || err != nil {
		if err != nil {
			writeError(w, err)
		} else {
			writeIconJSON(w, 200, cached)
		}
		return
	}
	result, err := a.storeWebsiteIcon(r, space.ID, origin, icon, sourceURL, fetchErr)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if result == nil && fetchErr != nil {
		writeError(w, fetchErr)
		return
	}
	writeIconJSON(w, 200, result)
}
