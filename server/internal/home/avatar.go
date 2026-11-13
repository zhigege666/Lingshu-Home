package home

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"time"
)

// Avatars belong to an account, not to a space or its published icon assets.
// Only normalized PNG bytes enter this table; the upload never touches files.
func accountAvatarURL(digest string) string {
	if digest == "" {
		return ""
	}
	return "/api/v1/account/avatar?digest=" + digest
}

func requireAccountAvatarSession(r *Request) error {
	if err := r.requireInitialized(); err != nil {
		return err
	}
	if r.User == nil {
		return unauthorized()
	}
	if r.Bearer {
		return forbidden()
	}
	return nil
}

func checkAccountAvatarVersion(r *Request, expected *string) error {
	if expected == nil || (*expected != "" && !iconDigestPattern.MatchString(*expected)) {
		return invalid("expectedAvatar must contain the current avatar digest, or an empty string for the default avatar.")
	}
	if *expected != r.User.AvatarDigest {
		return &APIError{Status: http.StatusConflict, Code: "avatar_version_conflict", Message: "Your avatar has changed. Reload it before saving."}
	}
	return nil
}

func (a *App) updateAccountAvatar(r *Request) (*Response, error) {
	if err := requireAccountAvatarSession(r); err != nil {
		return nil, err
	}
	// Bound the JSON body as well as the decoded image before image decoding.
	r.HTTP.Body = http.MaxBytesReader(r.Writer, r.HTTP.Body, int64(base64.StdEncoding.EncodedLen(iconMaxBytes)+1024))
	var input struct {
		MediaType      string  `json:"mediaType"`
		DataBase64     string  `json:"dataBase64"`
		ExpectedAvatar *string `json:"expectedAvatar"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	// route(write=true) holds the instance write gate before authenticating the
	// user in this transaction; a competing write reads its committed digest.
	if err := checkAccountAvatarVersion(r, input.ExpectedAvatar); err != nil {
		return nil, err
	}
	if input.MediaType != "image/png" && input.MediaType != "image/jpeg" {
		return nil, invalid("Avatars support PNG or JPEG images.")
	}
	if len(input.DataBase64) == 0 || len(input.DataBase64) > base64.StdEncoding.EncodedLen(iconMaxBytes) {
		return nil, invalid("Each avatar must contain 1 to 262144 decoded bytes.")
	}
	body, err := base64.StdEncoding.Strict().DecodeString(input.DataBase64)
	if err != nil {
		return nil, invalid("Avatar content must be standard base64 without a data URL prefix.")
	}
	icon, err := normalizeIcon(body, input.MediaType)
	if err != nil {
		return nil, err
	}
	if icon.Digest == r.User.AvatarDigest {
		return ok(r.User), nil
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query(`INSERT INTO account_avatars(user_id,digest,content,width,height,updated_at) VALUES(?,?,?,?,?,?)
 ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,content=excluded.content,width=excluded.width,height=excluded.height,updated_at=excluded.updated_at`),
		r.User.ID, icon.Digest, icon.Content, icon.Width, icon.Height, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	user := *r.User
	user.AvatarDigest, user.AvatarURL = icon.Digest, accountAvatarURL(icon.Digest)
	r.User = &user
	return ok(&user), nil
}

func (a *App) deleteAccountAvatar(r *Request) (*Response, error) {
	if err := requireAccountAvatarSession(r); err != nil {
		return nil, err
	}
	r.HTTP.Body = http.MaxBytesReader(r.Writer, r.HTTP.Body, 1024)
	var input struct {
		ExpectedAvatar *string `json:"expectedAvatar"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	if err := checkAccountAvatarVersion(r, input.ExpectedAvatar); err != nil {
		return nil, err
	}
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM account_avatars WHERE user_id=?"), r.User.ID); err != nil {
		return nil, err
	}
	user := *r.User
	user.AvatarDigest, user.AvatarURL = "", ""
	r.User = &user
	return ok(&user), nil
}

func (a *App) readAccountAvatar(r *Request) (*Response, error) {
	if err := requireAccountAvatarSession(r); err != nil {
		return nil, err
	}
	digest := r.HTTP.URL.Query().Get("digest")
	if !iconDigestPattern.MatchString(digest) || digest != r.User.AvatarDigest {
		return nil, missing()
	}
	var body []byte
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT content FROM account_avatars WHERE user_id=? AND digest=?"), r.User.ID, digest).Scan(&body); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, missing()
		}
		return nil, err
	}
	// Authenticate and check current ownership/existence before a possible 304.
	etag := `"` + digest + `"`
	r.Writer.Header().Set("Cache-Control", "private, no-cache")
	r.Writer.Header().Set("ETag", etag)
	r.Writer.Header().Set("Vary", "Cookie, Authorization")
	r.Writer.Header().Set("X-Content-Type-Options", "nosniff")
	r.Writer.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	r.Writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	if iconETagMatches(r.HTTP.Header.Values("If-None-Match"), etag) {
		return &Response{Status: http.StatusNotModified}, nil
	}
	return &Response{Status: http.StatusOK, Body: body, ContentType: "image/png"}, nil
}
