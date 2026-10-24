package home

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

const sessionCookie = "Lingshu.Session"
const csrfCookie = "Lingshu.Csrf"

// dummyPasswordHash is a public fixture used only to equalize password work for
// unknown accounts. Keep its policy aligned with hashPassword. Reusing it avoids
// an unnecessary 64 MiB Argon2 allocation during startup; each login still calls
// verifyPassword, and canLogin must reject a missing user even if this matches.
const dummyPasswordHash = "$argon2id$v=19$m=65536,t=3,p=1$bGluZ3NodS1kdW1teS12MQ$/OCHGFQdosF8cM1yw9NHYIpZJLBsriXSuFZePZ3O1dE"

func newID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes)
}
func randomToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}
func tokenHash(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func readOrCreateKey(path string) ([]byte, error) {
	key, err := os.ReadFile(path)
	if err == nil {
		if len(key) != 32 {
			return nil, errors.New("persistent key has invalid length")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key = make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return readOrCreateKey(path)
	}
	if err != nil {
		return nil, err
	}
	_, writeErr := f.Write(key)
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if syncErr != nil {
		return nil, syncErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return key, nil
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}

func verifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory, iterations uint32
	var parallelism uint8
	if n, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil || n != 3 {
		return false
	}
	if memory < 32*1024 || memory > 256*1024 || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 8 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func canLogin(user *User, s Settings) bool {
	return user != nil && user.IsEnabled && s.Initialized && (user.Role == "Owner" || (user.Role == "Member" && s.Mode == ModePrivateMulti))
}

func (a *App) loadSettings(ctx context.Context, q Queryer) (Settings, error) {
	var s Settings
	err := q.QueryRowContext(ctx, "SELECT initialized,site_name,mode,registration_enabled,auth_epoch,auto_fetch_icons,auto_select_endpoint,language FROM settings WHERE id=1").Scan(&s.Initialized, &s.SiteName, &s.Mode, &s.RegistrationEnabled, &s.AuthEpoch, &s.AutoFetchIcons, &s.AutoSelectEndpoint, &s.Language)
	if err != nil {
		return s, err
	}
	err = q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE role='Owner')").Scan(&s.HasOwner)
	return s, err
}

const userColumns = "id,username,display_name,role,is_enabled,password_hash,version"

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.IsEnabled, &u.PasswordHash, &u.Version); err != nil {
		return nil, err
	}
	return u, nil
}

func (a *App) loadUser(ctx context.Context, q Queryer, id string) (*User, error) {
	return scanUser(q.QueryRowContext(ctx, a.store.Query("SELECT "+userColumns+" FROM users WHERE id=?"), id))
}

func (a *App) authenticateCookie(r *Request) error {
	cookie, err := r.HTTP.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	clear := func() { a.clearSessionCookie(r); r.User = nil; r.SessionToken = "" }
	if len(cookie.Value) != 43 {
		clear()
		return nil
	}
	var userID string
	var epoch, version int64
	var expires databaseTime
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT user_id,auth_epoch,user_version,expires_at FROM sessions WHERE token_hash=?"), tokenHash(cookie.Value)).Scan(&userID, &epoch, &version, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		clear()
		return nil
	}
	if err != nil {
		return err
	}
	user, err := a.loadUser(r.HTTP.Context(), r.Q, userID)
	if errors.Is(err, sql.ErrNoRows) {
		clear()
		return nil
	}
	if err != nil {
		return err
	}
	if epoch != r.Settings.AuthEpoch || version != user.Version || !expires.After(time.Now()) || !canLogin(user, r.Settings) {
		clear()
		return nil
	}
	r.User = user
	r.SessionToken = cookie.Value
	return nil
}

func (a *App) issueSession(r *Request, user *User) error {
	raw := randomToken()
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at) VALUES(?,?,?,?,?)"), tokenHash(raw), user.ID, r.Settings.AuthEpoch, user.Version, time.Now().UTC().Add(12*time.Hour).Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	http.SetCookie(r.Writer, &http.Cookie{Name: sessionCookie, Value: raw, Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.HTTP.TLS != nil, SameSite: http.SameSiteLaxMode})
	r.SessionToken = raw
	r.User = user
	return nil
}

func (a *App) clearSessionCookie(r *Request) {
	http.SetCookie(r.Writer, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.HTTP.TLS != nil, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

func (a *App) csrfValue(r *Request, nonce string) string {
	identity := r.SessionToken
	if identity == "" {
		identity = "anonymous"
	}
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(nonce + "\x00" + identity + "\x00" + strconv.FormatInt(r.Settings.AuthEpoch, 10)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *App) csrfToken(r *Request) string {
	nonce := ""
	if cookie, err := r.HTTP.Cookie(csrfCookie); err == nil && len(cookie.Value) == 43 {
		nonce = cookie.Value
	}
	if nonce == "" {
		nonce = randomToken()
		http.SetCookie(r.Writer, &http.Cookie{Name: csrfCookie, Value: nonce, Path: "/", HttpOnly: true, Secure: a.config.SecureCookies || r.HTTP.TLS != nil, SameSite: http.SameSiteStrictMode})
	}
	return a.csrfValue(r, nonce)
}

func (a *App) checkCSRF(r *Request) error {
	if r.Bearer {
		return nil
	}
	cookie, err := r.HTTP.Cookie(csrfCookie)
	if err != nil || len(cookie.Value) != 43 || len(r.HTTP.Header.Values("X-CSRF-TOKEN")) != 1 {
		return &APIError{Status: 403, Code: "csrf_invalid", Message: "Refresh the page and retry with a current CSRF token."}
	}
	want := a.csrfValue(r, cookie.Value)
	got := r.HTTP.Header.Get("X-CSRF-TOKEN")
	if len(got) != len(want) || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return &APIError{Status: 403, Code: "csrf_invalid", Message: "Refresh the page and retry with a current CSRF token."}
	}
	return nil
}

type rateEntry struct {
	start time.Time
	count int
}
type authLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

func (l *authLimiter) allow(remote string) (bool, int) {
	key, _, err := net.SplitHostPort(remote)
	if err != nil {
		key = remote
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = make(map[string]rateEntry)
	}
	entry, exists := l.entries[key]
	if !exists || now.Sub(entry.start) >= time.Minute {
		if len(l.entries) >= 4096 {
			for k, v := range l.entries {
				if now.Sub(v.start) >= time.Minute {
					delete(l.entries, k)
				}
			}
		}
		if _, ok := l.entries[key]; !ok && len(l.entries) >= 4096 {
			return false, 60
		}
		entry = rateEntry{start: now}
	}
	if entry.count >= 20 {
		return false, max(1, int(time.Until(entry.start.Add(time.Minute)).Seconds())+1)
	}
	entry.count++
	l.entries[key] = entry
	return true, 0
}
