package home

import (
	"database/sql"
	"errors"
	"time"
)

// Cache entries and reservations share one per-space budget. Pending jobs for
// already cached origins do not consume a second slot.
func (a *App) iconOriginAdmission(r *Request, spaceID, origin string) (bool, error) {
	var count int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM (SELECT origin FROM icon_favicon_cache WHERE space_id=? UNION SELECT origin FROM icon_favicon_jobs WHERE space_id=?) reserved_origins"), spaceID, spaceID).Scan(&count); err != nil {
		return false, err
	}
	var reserved bool
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_favicon_cache WHERE space_id=? AND origin=?) OR EXISTS(SELECT 1 FROM icon_favicon_jobs WHERE space_id=? AND origin=?)"), spaceID, origin, spaceID, origin).Scan(&reserved); err != nil {
		return false, err
	}
	if count > 512 || count >= 512 && !reserved {
		return false, nil
	}
	var assets, bytes int64
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*),COALESCE(SUM(length(content)),0) FROM icon_assets WHERE space_id=?"), spaceID).Scan(&assets, &bytes); err != nil {
		return false, err
	}
	// Reserve enough headroom for one maximum-size normalized icon before
	// making a remote request. Actual insertion still checks the final bytes.
	return assets < 1024 && bytes+iconMaxBytes <= iconSpaceMaxBytes, nil
}

// storeWebsiteIcon only persists a completed fetch inside the caller's short,
// authorized write transaction. The caller owns commit and HTTP error delivery.
// A nil result after a failed fetch represents a persisted negative cache.
func (a *App) storeWebsiteIcon(r *Request, spaceID, origin string, icon normalizedIcon, sourceURL string, fetchErr error) (*iconFetchResponse, error) {
	var existing bool
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_favicon_cache WHERE space_id=? AND origin=?)"), spaceID, origin).Scan(&existing); err != nil {
		return nil, err
	}
	if !existing {
		allowed, err := a.iconOriginAdmission(r, spaceID, origin)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, invalid("The space's website icon cache or image storage is full.")
		}
	}
	var digest any
	lastError := ""
	retry := time.Now().UTC().Add(24 * time.Hour)
	if fetchErr != nil {
		lastError = "favicon_unavailable"
		retry = time.Now().UTC().Add(30 * time.Minute)
		if existing {
			var previous sql.NullString
			if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT digest,source_url FROM icon_favicon_cache WHERE space_id=? AND origin=?"), spaceID, origin).Scan(&previous, &sourceURL); err != nil {
				return nil, err
			}
			if previous.Valid {
				digest = previous.String
			}
		}
	} else {
		if err := a.insertIconAsset(r, spaceID, icon); err != nil {
			return nil, err
		}
		digest = icon.Digest
	}
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO icon_favicon_cache(space_id,origin,digest,source_url,checked_at,retry_at,last_error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(space_id,origin) DO UPDATE SET digest=excluded.digest,source_url=excluded.source_url,checked_at=excluded.checked_at,retry_at=excluded.retry_at,last_error=excluded.last_error"), spaceID, origin, digest, sourceURL, nowUTC(), retry.Format(time.RFC3339Nano), lastError)
	if err != nil || digest == nil {
		return nil, err
	}
	result, _, err := a.cachedWebsiteIcon(r, spaceID, origin)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Code == "favicon_unavailable" {
			return nil, nil
		}
		return nil, err
	}
	result.Cached = fetchErr != nil
	return result, nil
}
