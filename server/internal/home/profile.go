package home

import "net/http"

func (a *App) updateAccountProfile(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.User == nil {
		return nil, unauthorized()
	}
	if r.Bearer {
		return nil, forbidden()
	}
	var input struct {
		DisplayName         string  `json:"displayName"`
		ExpectedDisplayName *string `json:"expectedDisplayName"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	name, err := required(input.DisplayName, "displayName", 80)
	if err != nil {
		return nil, err
	}
	if input.ExpectedDisplayName == nil {
		return nil, invalid("expectedDisplayName is required.")
	}
	if *input.ExpectedDisplayName != r.User.DisplayName {
		return nil, &APIError{Status: http.StatusConflict, Code: "profile_version_conflict", Message: "Your profile has changed. Reload it before saving."}
	}
	if name == r.User.DisplayName {
		return ok(r.User), nil
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE users SET display_name=? WHERE id=?"), name, r.User.ID)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed != 1 {
		return nil, unauthorized()
	}
	user := *r.User
	user.DisplayName = name
	r.User = &user
	return ok(&user), nil
}
func (a *App) updateAccountPassword(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.User == nil {
		return nil, unauthorized()
	}
	if r.Bearer {
		return nil, forbidden()
	}
	var input struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	if !verifyPassword(input.CurrentPassword, r.User.PasswordHash) {
		return nil, &APIError{Status: http.StatusBadRequest, Code: "current_password_incorrect", Message: "Current password is incorrect."}
	}
	if _, _, err := validateCredentials(r.User.Username, r.User.DisplayName, input.NewPassword); err != nil {
		return nil, err
	}
	if input.NewPassword == input.CurrentPassword {
		return nil, invalid("New password must be different from the current password.")
	}
	hash, err := hashPassword(input.NewPassword)
	if err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE users SET password_hash=?,version=version+1 WHERE id=? AND version=?"), hash, r.User.ID, r.User.Version)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed != 1 {
		return nil, &APIError{Status: http.StatusConflict, Code: "account_version_conflict", Message: "Your account has changed. Sign in again before changing its password."}
	}
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE user_id=?"), r.User.ID); err != nil {
		return nil, err
	}
	user := *r.User
	user.PasswordHash = hash
	user.Version++
	if err := a.issueSessionWithChoice(r, &user, sessionChoiceAfterPasswordChange(r.SessionInfo, r.Settings.SessionPolicy)); err != nil {
		return nil, err
	}
	return ok(map[string]bool{"success": true}), nil
}
