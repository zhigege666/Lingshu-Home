package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"time"
)

const automaticIconPendingLimit = 2048

type iconModeInput string

func (v *iconModeInput) UnmarshalJSON(raw []byte) error {
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil || value == nil || (*value != "auto" && *value != "manual") {
		return invalid("iconMode must be auto or manual")
	}
	*v = iconModeInput(*value)
	return nil
}

type optionalIconBool struct {
	present bool
	value   bool
}

func (v *optionalIconBool) UnmarshalJSON(raw []byte) error {
	var value *bool
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return invalid("autoFetchIcons must be a boolean")
	}
	v.present, v.value = true, *value
	return nil
}

func automaticIconOrigin(raw string) string {
	u, err := iconWebsiteOrigin(raw)
	if err != nil {
		return ""
	}
	return u.String()
}

func (a *App) prepareAutomaticLinkIcon(r *Request, link *Link) (string, error) {
	if link.IconMode == "manual" {
		return "", nil
	}
	if link.IconMode != "auto" {
		return "", invalid("iconMode must be auto or manual")
	}
	origin := automaticIconOrigin(link.URL)
	if origin == "" {
		return "", nil // Blocked fetch destinations remain valid navigation links.
	}
	var digest sql.NullString
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT digest FROM icon_favicon_cache WHERE space_id=? AND origin=?"), link.SpaceID, origin).Scan(&digest)
	if errors.Is(err, sql.ErrNoRows) {
		return origin, nil
	}
	if err != nil {
		return "", err
	}
	// A saved image remains usable even when fetching is disabled or refresh
	// failed. This read never starts network work or changes other bookmarks.
	if digest.Valid {
		link.Icon = "asset:" + link.SpaceID + ":" + digest.String
	}
	return origin, nil
}

func (a *App) queueAutomaticIcon(r *Request, spaceID, origin string) error {
	if !r.Settings.AutoFetchIcons || origin == "" {
		return nil
	}
	_, fresh, err := a.cachedWebsiteIcon(r, spaceID, origin)
	if fresh {
		var api *APIError
		if err == nil || errors.As(err, &api) && api.Code == "favicon_unavailable" {
			return nil
		}
	}
	if err != nil {
		return err
	}
	allowed, err := a.iconOriginAdmission(r, spaceID, origin)
	if err != nil || !allowed {
		return err // Capacity never makes a bookmark save or import fail.
	}
	var exists bool
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_favicon_jobs WHERE space_id=? AND origin=?)"), spaceID, origin).Scan(&exists); err != nil {
		return err
	}
	if exists {
		prior := automaticIconJob{spaceID: spaceID, origin: origin}
		var actor sql.NullString
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,auth_epoch,actor_user_id,actor_user_version,token_hash FROM icon_favicon_jobs WHERE space_id=? AND origin=?"), spaceID, origin).Scan(&prior.id, &prior.epoch, &actor, &prior.actorVersion, &prior.tokenHash); err != nil {
			return err
		}
		prior.actorID = actor.String
		if _, err = a.automaticIconRequest(r.HTTP.Context(), r.Q, prior); err == nil {
			// Preserve the running task's identity and FIFO position. A second
			// bookmark for the same origin shares the completed result.
			r.WakeAutoIcons = true
			return nil
		}
		var api *APIError
		if !errors.As(err, &api) {
			return err
		}
	}
	if !exists {
		var pending int
		if err = r.Q.QueryRowContext(r.HTTP.Context(), "SELECT COUNT(*) FROM icon_favicon_jobs").Scan(&pending); err != nil {
			return err
		}
		if pending >= automaticIconPendingLimit {
			return nil
		}
	}
	var actor any
	var version int64
	if r.User != nil {
		actor, version = r.User.ID, r.User.Version
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(space_id,origin) DO UPDATE SET id=excluded.id,auth_epoch=excluded.auth_epoch,actor_user_id=excluded.actor_user_id,actor_user_version=excluded.actor_user_version,token_hash=excluded.token_hash,requested_at=excluded.requested_at"), spaceID, origin, newID(), r.Settings.AuthEpoch, actor, version, r.BearerTokenHash, nowUTC())
	if err == nil {
		r.WakeAutoIcons = true
	}
	return err
}

func (a *App) cleanAutomaticIconJobs(r *Request, spaceID string) error {
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM icon_favicon_jobs WHERE space_id=? AND NOT EXISTS(SELECT 1 FROM links WHERE links.space_id=icon_favicon_jobs.space_id AND links.icon_mode='auto' AND links.icon_origin=icon_favicon_jobs.origin)"), spaceID)
	if err != nil {
		return err
	}
	if changed, e := result.RowsAffected(); e != nil {
		return e
	} else if changed > 0 {
		r.WakeAutoIcons = true
	}
	return nil
}

func (a *App) afterAutoIconCommit(r *Request) {
	if r.CancelAutoIcons {
		a.autoIconMu.Lock()
		if a.autoIconCancel != nil {
			a.autoIconCancel()
		}
		a.autoIconMu.Unlock()
	}
	if r.WakeAutoIcons || r.CancelAutoIcons {
		a.wakeAutoIconWorker()
	}
}

func (a *App) wakeAutoIconWorker() {
	select {
	case a.autoIconWake <- struct{}{}:
	default:
	}
}

type automaticIconJob struct {
	id, spaceID, origin string
	epoch               int64
	actorID             string
	actorVersion        int64
	tokenHash           string
}

func (a *App) nextAutomaticIconJob(ctx context.Context) (*automaticIconJob, error) {
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, err
	}
	job := &automaticIconJob{}
	var actor sql.NullString
	err := a.store.DB.QueryRowContext(ctx, "SELECT id,space_id,origin,auth_epoch,actor_user_id,actor_user_version,token_hash FROM icon_favicon_jobs ORDER BY requested_at,id LIMIT 1").Scan(&job.id, &job.spaceID, &job.origin, &job.epoch, &actor, &job.actorVersion, &job.tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	job.actorID = actor.String
	return job, err
}

func (a *App) automaticIconRequest(ctx context.Context, q Queryer, job automaticIconJob) (*Request, error) {
	var current bool
	if err := q.QueryRowContext(ctx, a.store.Query("SELECT EXISTS(SELECT 1 FROM icon_favicon_jobs WHERE space_id=? AND origin=? AND id=?)"), job.spaceID, job.origin, job.id).Scan(&current); err != nil {
		return nil, err
	}
	if !current {
		return nil, missing()
	}
	settings, err := a.loadSettings(ctx, q)
	if err != nil {
		return nil, err
	}
	if !settings.AutoFetchIcons || settings.AuthEpoch != job.epoch {
		return nil, forbidden()
	}
	h := (&http.Request{Method: "POST", URL: &url.URL{Path: "/internal/automatic-icon"}}).WithContext(ctx)
	r := &Request{App: a, HTTP: h, Q: q, Settings: settings}
	if job.tokenHash != "" {
		if err = a.authenticateBearerHash(r, job.tokenHash); err != nil {
			return nil, err
		}
	} else if job.actorID != "" {
		r.User, err = a.loadUser(ctx, q, job.actorID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, unauthorized()
		}
		if err != nil {
			return nil, err
		}
	}
	if job.actorID != "" && (r.User == nil || r.User.ID != job.actorID || r.User.Version != job.actorVersion || !canLogin(r.User, settings)) {
		return nil, unauthorized()
	}
	if job.actorID == "" && (r.User != nil || job.tokenHash != "") {
		return nil, unauthorized()
	}
	if _, err = r.navigationSpace(job.spaceID, true); err != nil {
		return nil, err
	}
	if err = q.QueryRowContext(ctx, a.store.Query("SELECT EXISTS(SELECT 1 FROM links WHERE space_id=? AND icon_mode='auto' AND icon_origin=?)"), job.spaceID, job.origin).Scan(&current); err != nil {
		return nil, err
	}
	if !current || automaticIconOrigin(job.origin) != job.origin {
		return nil, missing()
	}
	return r, nil
}

func (a *App) deleteAutomaticIconJob(ctx context.Context, q Queryer, job automaticIconJob) error {
	_, err := q.ExecContext(ctx, a.store.Query("DELETE FROM icon_favicon_jobs WHERE space_id=? AND origin=? AND id=?"), job.spaceID, job.origin, job.id)
	return err
}

func (a *App) applyAutomaticIcon(r *Request, job automaticIconJob, result *iconFetchResponse) error {
	if result == nil {
		return nil
	}
	changed, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET icon=?,updated_at=? WHERE space_id=? AND icon_mode='auto' AND icon_origin=? AND icon<>?"), result.Ref, nowUTC(), job.spaceID, job.origin, result.Ref)
	if err != nil {
		return err
	}
	n, err := changed.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	return a.touchNavigation(r, job.spaceID)
}

func (a *App) processAutomaticIconJob(ctx context.Context, job automaticIconJob) (bool, error) {
	select {
	case a.iconFetchGate <- struct{}{}:
		defer func() { <-a.iconFetchGate }()
	case <-ctx.Done():
		return false, ctx.Err()
	}
	shouldFetch := false
	err := a.integrationTransaction(ctx, func(q Queryer) error {
		r, err := a.automaticIconRequest(ctx, q, job)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) {
				return a.deleteAutomaticIconJob(ctx, q, job)
			}
			return err
		}
		cached, fresh, err := a.cachedWebsiteIcon(r, job.spaceID, job.origin)
		if fresh {
			var api *APIError
			if err != nil && !(errors.As(err, &api) && api.Code == "favicon_unavailable") {
				return err
			}
			if err = a.applyAutomaticIcon(r, job, cached); err != nil {
				return err
			}
			return a.deleteAutomaticIconJob(ctx, q, job)
		}
		if err != nil {
			return err
		}
		allowed, err := a.iconOriginAdmission(r, job.spaceID, job.origin)
		if err != nil {
			return err
		}
		if !allowed {
			return a.deleteAutomaticIconJob(ctx, q, job)
		}
		shouldFetch = true
		return nil
	})
	if err != nil || !shouldFetch {
		return false, err
	}
	ctx, done := a.beginNetworkOperation(ctx)
	defer done()
	target, _ := iconWebsiteOrigin(job.origin)
	icon, sourceURL, fetchErr := fetchWebsiteIcon(ctx, a.iconHTTPClient, target)
	if ctx.Err() != nil {
		return true, ctx.Err() // Ordinary shutdown leaves the durable job for restart.
	}
	return true, a.integrationTransaction(ctx, func(q Queryer) error {
		if err := a.checkNetworkOperation(ctx, q); err != nil {
			return err
		}
		r, err := a.automaticIconRequest(ctx, q, job)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) {
				return a.deleteAutomaticIconJob(ctx, q, job)
			}
			return err
		}
		result, err := a.storeWebsiteIcon(r, job.spaceID, job.origin, icon, sourceURL, fetchErr)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) {
				return a.deleteAutomaticIconJob(ctx, q, job)
			}
			return err
		}
		if err = a.applyAutomaticIcon(r, job, result); err != nil {
			return err
		}
		return a.deleteAutomaticIconJob(ctx, q, job)
	})
}

func (a *App) startAutoIconWorker() {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		yieldBeforeNext := false
		for a.ctx.Err() == nil {
			job, err := a.nextAutomaticIconJob(a.ctx)
			if err != nil || job == nil {
				if err != nil && a.ctx.Err() == nil {
					log.Printf("automatic icon queue unavailable (%T)", err)
				}
				select {
				case <-a.ctx.Done():
					return
				case <-a.autoIconWake:
					yieldBeforeNext = false
					continue
				}
			}
			if yieldBeforeNext {
				// Only a nonempty queue creates this short timer. Releasing the
				// shared fetch gate between jobs leaves room for explicit fetches.
				timer := time.NewTimer(200 * time.Millisecond)
				select {
				case <-a.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			ctx, cancel := context.WithCancel(a.ctx)
			a.autoIconMu.Lock()
			a.autoIconCancel = cancel
			a.autoIconMu.Unlock()
			networked, processErr := a.processAutomaticIconJob(ctx, *job)
			err = processErr
			a.autoIconMu.Lock()
			a.autoIconCancel = nil
			a.autoIconMu.Unlock()
			cancel()
			yieldBeforeNext = networked
			if err != nil && !errors.Is(err, context.Canceled) && a.ctx.Err() == nil {
				log.Printf("automatic icon task unavailable (%T)", err)
				// A database failure must not spin or create a retry ticker.
				// Another committed intent or an ordinary restart can retry.
				select {
				case <-a.ctx.Done():
					return
				case <-a.autoIconWake:
				}
			}
		}
	}()
}
