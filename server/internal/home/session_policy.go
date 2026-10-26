package home

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	sessionTemporary        = "temporary"
	sessionRemember         = "remember"
	sessionUntilLogout      = "until_logout"
	sessionRenewInterval    = 15 * time.Minute
	retentionSessionColumns = "token_hash,user_id,auth_epoch,user_version,expires_at,session_mode,idle_days,created_at,last_interactive_at,renewed_at,user_agent"
)

var untilLogoutDatabaseExpiry = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)

type SessionPolicy struct {
	DefaultMode      string `json:"defaultMode"`
	DefaultIdleDays  int    `json:"defaultIdleDays"`
	MaxIdleDays      int    `json:"maxIdleDays"`
	AllowUntilLogout bool   `json:"allowUntilLogout"`
	PolicyVersion    int64  `json:"policyVersion"`
}
type SessionChoice struct {
	SessionMode  string `json:"sessionMode"`
	RememberDays int    `json:"rememberDays,omitempty"`
}
type SessionOptions struct {
	DefaultMode      string `json:"defaultMode"`
	DefaultIdleDays  int    `json:"defaultIdleDays"`
	MaxIdleDays      int    `json:"maxIdleDays"`
	AllowUntilLogout bool   `json:"allowUntilLogout"`
	RememberDays     []int  `json:"rememberDays"`
}
type SessionSummary struct {
	Mode              string `json:"mode"`
	IdleDays          int    `json:"idleDays,omitempty"`
	ExpiresAt         string `json:"expiresAt,omitempty"`
	RenewAfterSeconds int    `json:"renewAfterSeconds"`
}
type SessionRecord struct {
	TokenHash         string `json:"-"`
	UserID            string `json:"-"`
	AuthEpoch         int64  `json:"-"`
	UserVersion       int64  `json:"-"`
	ExpiresAt         time.Time
	Mode              string
	IdleDays          int
	CreatedAt         time.Time
	LastInteractiveAt time.Time
	RenewedAt         time.Time
	UserAgent         string
}
type BrowserSessionView struct {
	ID                string `json:"id"`
	Current           bool   `json:"current"`
	Mode              string `json:"mode"`
	IdleDays          int    `json:"idleDays,omitempty"`
	CreatedAt         string `json:"createdAt,omitempty"`
	LastInteractiveAt string `json:"lastInteractiveAt,omitempty"`
	ExpiresAt         string `json:"expiresAt,omitempty"`
	UserAgent         string `json:"userAgent"`
}
type sessionScanner interface{ Scan(...any) error }

func sessionNow() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }
func sessionTimeString(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
func nullableSessionTime(value any) (time.Time, error) {
	if value == nil {
		return time.Time{}, nil
	}
	var parsed databaseTime
	if err := parsed.Scan(value); err != nil {
		return time.Time{}, fmt.Errorf("invalid stored session timestamp: %w", err)
	}
	return parsed.Time, nil
}
func scanSessionRecord(row sessionScanner) (*SessionRecord, error) {
	var result SessionRecord
	var expiry databaseTime
	var created, last, renewed any
	if err := row.Scan(&result.TokenHash, &result.UserID, &result.AuthEpoch, &result.UserVersion, &expiry, &result.Mode, &result.IdleDays, &created, &last, &renewed, &result.UserAgent); err != nil {
		return nil, err
	}
	result.ExpiresAt = expiry.Time
	var err error
	if result.CreatedAt, err = nullableSessionTime(created); err != nil {
		return nil, err
	}
	if result.LastInteractiveAt, err = nullableSessionTime(last); err != nil {
		return nil, err
	}
	if result.RenewedAt, err = nullableSessionTime(renewed); err != nil {
		return nil, err
	}
	return &result, nil
}
func (a *App) readSessionRecord(ctx context.Context, q Queryer, hash string) (*SessionRecord, error) {
	return scanSessionRecord(q.QueryRowContext(ctx, a.store.Query("SELECT "+retentionSessionColumns+" FROM sessions WHERE token_hash=?"), hash))
}
func validRememberDays(days int) bool { return days == 7 || days == 30 || days == 90 }
func validateSessionPolicy(policy SessionPolicy) error {
	if !validRememberDays(policy.MaxIdleDays) || !validRememberDays(policy.DefaultIdleDays) || policy.DefaultIdleDays > policy.MaxIdleDays {
		return invalid("Choose a supported default login duration within the site limit.")
	}
	switch policy.DefaultMode {
	case sessionTemporary, sessionRemember:
	case sessionUntilLogout:
		if !policy.AllowUntilLogout {
			return invalid("Enable keeping login until sign-out before selecting it as the default.")
		}
	default:
		return invalid("Unknown default session mode.")
	}
	return nil
}
func sessionOptions(policy SessionPolicy) SessionOptions {
	days := make([]int, 0, 3)
	for _, value := range []int{7, 30, 90} {
		if value <= policy.MaxIdleDays {
			days = append(days, value)
		}
	}
	return SessionOptions{DefaultMode: policy.DefaultMode, DefaultIdleDays: policy.DefaultIdleDays, MaxIdleDays: policy.MaxIdleDays, AllowUntilLogout: policy.AllowUntilLogout, RememberDays: days}
}
func resolveSessionChoice(policy SessionPolicy, choice SessionChoice) (string, int, error) {
	mode := choice.SessionMode
	if mode == "" {
		mode = sessionTemporary
	}
	switch mode {
	case sessionTemporary:
		if choice.RememberDays != 0 {
			return "", 0, invalid("Temporary login does not accept a remembered duration.")
		}
		return mode, 0, nil
	case sessionRemember:
		if !validRememberDays(choice.RememberDays) || choice.RememberDays > policy.MaxIdleDays {
			return "", 0, invalid("The remembered login duration is not allowed by this site.")
		}
		return mode, choice.RememberDays, nil
	case sessionUntilLogout:
		if choice.RememberDays != 0 || !policy.AllowUntilLogout {
			return "", 0, invalid("Keeping login until sign-out is not enabled by this site.")
		}
		return mode, 0, nil
	default:
		return "", 0, invalid("Unknown session mode.")
	}
}
func sessionExpiry(record *SessionRecord, policy SessionPolicy) time.Time {
	expiry := record.ExpiresAt
	if record.Mode == sessionRemember && !record.LastInteractiveAt.IsZero() {
		days := record.IdleDays
		if policy.MaxIdleDays < days {
			days = policy.MaxIdleDays
		}
		idleExpiry := record.LastInteractiveAt.Add(time.Duration(days) * 24 * time.Hour)
		if idleExpiry.Before(expiry) {
			expiry = idleExpiry
		}
	}
	return expiry
}
func usableSession(record *SessionRecord, policy SessionPolicy, now time.Time) bool {
	if record == nil || !sessionExpiry(record, policy).After(now) {
		return false
	}
	switch record.Mode {
	case sessionTemporary:
		return true
	case sessionRemember:
		return validRememberDays(record.IdleDays) && validRememberDays(policy.MaxIdleDays) && !record.LastInteractiveAt.IsZero() && !record.RenewedAt.IsZero()
	case sessionUntilLogout:
		return policy.AllowUntilLogout
	default:
		return false
	}
}
func sessionSummary(record *SessionRecord, policy SessionPolicy, now time.Time) *SessionSummary {
	if record == nil {
		return nil
	}
	result := &SessionSummary{Mode: record.Mode}
	if record.Mode == sessionRemember {
		result.IdleDays = record.IdleDays
		if policy.MaxIdleDays < result.IdleDays {
			result.IdleDays = policy.MaxIdleDays
		}
	}
	if record.Mode != sessionUntilLogout {
		result.ExpiresAt = sessionTimeString(sessionExpiry(record, policy))
	}
	if record.Mode != sessionTemporary && !record.RenewedAt.IsZero() {
		remaining := record.RenewedAt.Add(sessionRenewInterval).Sub(now)
		if remaining > 0 {
			result.RenewAfterSeconds = int((remaining + time.Second - 1) / time.Second)
		}
	}
	return result
}
func sessionChoiceAfterPasswordChange(record *SessionRecord, policy SessionPolicy) SessionChoice {
	if record == nil {
		return SessionChoice{}
	}
	if record.Mode == sessionUntilLogout && policy.AllowUntilLogout {
		return SessionChoice{SessionMode: sessionUntilLogout}
	}
	if record.Mode == sessionRemember {
		days := record.IdleDays
		if days > policy.MaxIdleDays {
			days = policy.MaxIdleDays
		}
		if validRememberDays(days) {
			return SessionChoice{SessionMode: sessionRemember, RememberDays: days}
		}
	}
	return SessionChoice{SessionMode: sessionTemporary}
}
func sessionUserAgent(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	runes := []rune(value)
	if len(runes) > 256 {
		value = string(runes[:256])
	}
	return value
}
func (a *App) setRetainedSessionCookie(r *Request, raw string, record *SessionRecord, now time.Time) {
	cookie := &http.Cookie{Name: sessionCookie, Value: raw, Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.HTTP.TLS != nil, SameSite: http.SameSiteLaxMode}
	if record.Mode != sessionTemporary {
		expiry := record.ExpiresAt
		if record.Mode == sessionUntilLogout {
			expiry = now.Add(365 * 24 * time.Hour)
		}
		cookie.Expires = expiry
		cookie.MaxAge = int((expiry.Sub(now) + time.Second - 1) / time.Second)
		if cookie.MaxAge < 1 {
			cookie.MaxAge = 1
		}
	}
	http.SetCookie(r.Writer, cookie)
}
func (a *App) expireBrowserSession(r *Request) {
	http.SetCookie(r.Writer, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.HTTP.TLS != nil, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0).UTC()})
	r.User = nil
	r.SessionToken = ""
	r.SessionInfo = nil
}
func (a *App) issueSessionWithChoice(r *Request, user *User, choice SessionChoice) error {
	mode, days, err := resolveSessionChoice(r.Settings.SessionPolicy, choice)
	if err != nil {
		return err
	}
	now := sessionNow()
	expiry := now.Add(12 * time.Hour)
	if mode == sessionRemember {
		expiry = now.Add(time.Duration(days) * 24 * time.Hour)
	}
	if mode == sessionUntilLogout {
		expiry = untilLogoutDatabaseExpiry
	}
	raw := randomToken()
	record := &SessionRecord{TokenHash: tokenHash(raw), UserID: user.ID, AuthEpoch: r.Settings.AuthEpoch, UserVersion: user.Version, ExpiresAt: expiry, Mode: mode, IdleDays: days, CreatedAt: now, LastInteractiveAt: now, RenewedAt: now, UserAgent: sessionUserAgent(r.HTTP.UserAgent())}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at,session_mode,idle_days,created_at,last_interactive_at,renewed_at,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?,?)"), record.TokenHash, user.ID, record.AuthEpoch, record.UserVersion, sessionTimeString(expiry), mode, days, sessionTimeString(now), sessionTimeString(now), sessionTimeString(now), record.UserAgent)
	if err != nil {
		return err
	}
	a.setRetainedSessionCookie(r, raw, record, now)
	r.SessionToken = raw
	r.User = user
	r.SessionInfo = record
	return nil
}
func (r *Request) requireBrowserSession() error {
	if err := r.requireInitialized(); err != nil {
		return err
	}
	if r.Bearer {
		return forbidden()
	}
	if r.User == nil || r.SessionToken == "" || r.SessionInfo == nil {
		return unauthorized()
	}
	return nil
}
func (a *App) renewSession(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	var input struct{}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	record := r.SessionInfo
	now := sessionNow()
	if !usableSession(record, r.Settings.SessionPolicy, now) {
		return nil, unauthorized()
	}
	if record.Mode == sessionTemporary || (!record.RenewedAt.IsZero() && now.Sub(record.RenewedAt) < sessionRenewInterval) {
		return ok(map[string]any{"session": sessionSummary(record, r.Settings.SessionPolicy, now)}), nil
	}
	days := record.IdleDays
	expiry := record.ExpiresAt
	if record.Mode == sessionRemember {
		if days > r.Settings.SessionPolicy.MaxIdleDays {
			days = r.Settings.SessionPolicy.MaxIdleDays
		}
		expiry = now.Add(time.Duration(days) * 24 * time.Hour)
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE sessions SET idle_days=?,expires_at=?,last_interactive_at=?,renewed_at=? WHERE token_hash=? AND user_id=? AND auth_epoch=? AND user_version=?"), days, sessionTimeString(expiry), sessionTimeString(now), sessionTimeString(now), record.TokenHash, r.User.ID, r.Settings.AuthEpoch, r.User.Version)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, unauthorized()
	}
	record.IdleDays = days
	record.ExpiresAt = expiry
	record.LastInteractiveAt = now
	record.RenewedAt = now
	a.setRetainedSessionCookie(r, r.SessionToken, record, now)
	return ok(map[string]any{"session": sessionSummary(record, r.Settings.SessionPolicy, now)}), nil
}
func (a *App) getSessionPolicy(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	return ok(r.Settings.SessionPolicy), nil
}
func (a *App) updateSessionPolicy(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	var input struct {
		DefaultMode      string `json:"defaultMode"`
		DefaultIdleDays  int    `json:"defaultIdleDays"`
		MaxIdleDays      int    `json:"maxIdleDays"`
		AllowUntilLogout bool   `json:"allowUntilLogout"`
		ExpectedVersion  int64  `json:"expectedVersion"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	policy := SessionPolicy{DefaultMode: input.DefaultMode, DefaultIdleDays: input.DefaultIdleDays, MaxIdleDays: input.MaxIdleDays, AllowUntilLogout: input.AllowUntilLogout, PolicyVersion: input.ExpectedVersion + 1}
	if input.ExpectedVersion < 1 {
		return nil, invalid("A current session policy version is required.")
	}
	if err := validateSessionPolicy(policy); err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET default_session_mode=?,default_idle_days=?,max_idle_days=?,allow_until_logout=?,session_policy_version=session_policy_version+1 WHERE id=1 AND session_policy_version=?"), policy.DefaultMode, policy.DefaultIdleDays, policy.MaxIdleDays, policy.AllowUntilLogout, input.ExpectedVersion)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, &APIError{Status: http.StatusConflict, Code: "session_policy_conflict", Message: "Login settings changed. Read the current settings before saving again.", CurrentRevision: strconv.FormatInt(r.Settings.SessionPolicy.PolicyVersion, 10)}
	}
	if err := a.constrainRememberedSessions(r, policy.MaxIdleDays); err != nil {
		return nil, err
	}
	if !policy.AllowUntilLogout {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE session_mode=?"), sessionUntilLogout); err != nil {
			return nil, err
		}
	}
	r.Settings.SessionPolicy = policy
	if r.SessionToken != "" {
		current, err := a.readSessionRecord(r.HTTP.Context(), r.Q, tokenHash(r.SessionToken))
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		now := sessionNow()
		if current == nil || !usableSession(current, policy, now) {
			a.expireBrowserSession(r)
		} else {
			r.SessionInfo = current
			a.setRetainedSessionCookie(r, r.SessionToken, current, now)
		}
	}
	return ok(policy), nil
}
func (a *App) constrainRememberedSessions(r *Request, maxDays int) error {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT token_hash,expires_at,last_interactive_at FROM sessions WHERE session_mode=? AND idle_days>?"), sessionRemember, maxDays)
	if err != nil {
		return err
	}
	type update struct {
		hash   string
		expiry time.Time
		remove bool
	}
	updates := make([]update, 0)
	for rows.Next() {
		var hash string
		var expiry databaseTime
		var activity any
		if err := rows.Scan(&hash, &expiry, &activity); err != nil {
			rows.Close()
			return err
		}
		last, err := nullableSessionTime(activity)
		if err != nil {
			rows.Close()
			return err
		}
		item := update{hash: hash, expiry: expiry.Time, remove: last.IsZero()}
		if !last.IsZero() {
			limit := last.Add(time.Duration(maxDays) * 24 * time.Hour)
			if limit.Before(item.expiry) {
				item.expiry = limit
			}
		}
		updates = append(updates, item)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	for _, item := range updates {
		if item.remove {
			if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE token_hash=?"), item.hash); err != nil {
				return err
			}
		} else {
			if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE sessions SET idle_days=?,expires_at=? WHERE token_hash=?"), maxDays, sessionTimeString(item.expiry), item.hash); err != nil {
				return err
			}
		}
	}
	return nil
}
func (a *App) publicSessionID(hash string) string {
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte("lingshu:browser-session:v1\x00"))
	_, _ = mac.Write([]byte(hash))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (a *App) activeBrowserSessions(r *Request) ([]*SessionRecord, error) {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+retentionSessionColumns+" FROM sessions WHERE user_id=? AND auth_epoch=? AND user_version=?"), r.User.ID, r.Settings.AuthEpoch, r.User.Version)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*SessionRecord, 0)
	now := sessionNow()
	for rows.Next() {
		record, err := scanSessionRecord(rows)
		if err != nil {
			return nil, err
		}
		if usableSession(record, r.Settings.SessionPolicy, now) {
			result = append(result, record)
		}
	}
	return result, rows.Err()
}
func (a *App) listBrowserSessions(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	records, err := a.activeBrowserSessions(r)
	if err != nil {
		return nil, err
	}
	currentHash := tokenHash(r.SessionToken)
	sort.SliceStable(records, func(i, j int) bool {
		if (records[i].TokenHash == currentHash) != (records[j].TokenHash == currentHash) {
			return records[i].TokenHash == currentHash
		}
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})
	result := make([]BrowserSessionView, 0, len(records))
	now := sessionNow()
	for _, record := range records {
		summary := sessionSummary(record, r.Settings.SessionPolicy, now)
		result = append(result, BrowserSessionView{ID: a.publicSessionID(record.TokenHash), Current: record.TokenHash == currentHash, Mode: summary.Mode, IdleDays: summary.IdleDays, CreatedAt: sessionTimeString(record.CreatedAt), LastInteractiveAt: sessionTimeString(record.LastInteractiveAt), ExpiresAt: summary.ExpiresAt, UserAgent: record.UserAgent})
	}
	return ok(map[string]any{"sessions": result}), nil
}
func (a *App) revokeBrowserSession(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	var input struct {
		ID string `json:"id"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	decoded, err := base64.RawURLEncoding.DecodeString(input.ID)
	if err != nil || len(decoded) != sha256.Size {
		return nil, invalid("Invalid browser session reference.")
	}
	records, err := a.activeBrowserSessions(r)
	if err != nil {
		return nil, err
	}
	var target *SessionRecord
	for _, record := range records {
		if hmac.Equal([]byte(a.publicSessionID(record.TokenHash)), []byte(input.ID)) {
			target = record
			break
		}
	}
	if target == nil {
		return nil, missing()
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE token_hash=? AND user_id=?"), target.TokenHash, r.User.ID)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, missing()
	}
	current := target.TokenHash == tokenHash(r.SessionToken)
	if current {
		a.expireBrowserSession(r)
	}
	return ok(map[string]any{"revoked": true, "current": current}), nil
}
func (a *App) revokeOtherBrowserSessions(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	var input struct{}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE user_id=? AND token_hash<>?"), r.User.ID, tokenHash(r.SessionToken))
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"revoked": count}), nil
}
