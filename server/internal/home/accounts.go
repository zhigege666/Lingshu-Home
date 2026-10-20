package home

import (
	"database/sql"
	"errors"
	"strings"
)

type accountInput struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

func (a *App) bootstrap(r *Request) (*Response, error) {
	spaces, err := a.accessibleSpaces(r)
	if err != nil {
		return nil, err
	}
	var defaultID any
	for _, s := range spaces {
		if defaultID == nil || r.User != nil && s.Kind == "personal" {
			defaultID = s.ID
		}
	}
	capabilities := map[string]any{
		"sourceKinds": []string{"local-navigation"}, "deliveryModes": []string{},
		"datasetSchemas":     []map[string]any{{"id": "navigation.collection", "version": 1}},
		"pageSchemaVersions": []int{2}, "themePackages": []string{"builtin"},
		"pageThemes":  []string{"builtin/dashboard", "builtin/ios"},
		"panelThemes": []string{"builtin/category-navigation", "builtin/search", "builtin/favorites", "builtin/navigation", "builtin/github-traffic", "builtin/calendar", "builtin/weather", "builtin/metrics", "builtin/status"},
		"layoutModes": []string{"regions-grid"}, "authModes": []string{ModeOpenEdit, ModePublicRead, ModePrivateSingle, ModePrivateMulti},
	}
	for key, value := range integrationCapabilities() {
		capabilities[key] = value
	}
	capabilities["pageChrome"] = map[string]any{"regions": []string{"header", "footer"}, "alignments": []string{"left", "center", "right"}, "itemTypes": []string{"text", "link", "branding"}, "maxItemsPerSlot": 8}
	return ok(map[string]any{"version": a.version, "language": a.config.Language, "initialized": r.Settings.Initialized, "siteName": r.Settings.SiteName, "mode": r.Settings.Mode, "registrationEnabled": r.Settings.RegistrationEnabled, "autoFetchIcons": r.Settings.AutoFetchIcons, "autoSelectEndpoint": r.Settings.AutoSelectEndpoint, "user": r.User, "spaces": spaces, "defaultSpaceId": defaultID, "csrfToken": a.csrfToken(r), "capabilities": capabilities}), nil
}

func (a *App) insertUser(r *Request, input accountInput, role string) (*User, error) {
	username, displayName, err := validateCredentials(input.Username, input.DisplayName, input.Password)
	if err != nil {
		return nil, err
	}
	var exists bool
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM users WHERE normalized_username=?)"), strings.ToLower(username)).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("That username already exists.")
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		return nil, err
	}
	user := &User{ID: newID(), Username: username, DisplayName: displayName, Role: role, IsEnabled: true, PasswordHash: hash, Version: 1}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)"), user.ID, user.Username, strings.ToLower(user.Username), user.DisplayName, user.Role, true, hash, user.Version, nowUTC())
	if err != nil {
		return nil, err
	}
	_, err = a.insertSpace(r, a.localized(displayName+" 的空间", displayName+"'s space"), "personal", user.ID, false)
	return user, err
}

func (a *App) setup(r *Request) (*Response, error) {
	if r.Settings.Initialized {
		return nil, conflict("The instance is already initialized.")
	}
	if r.Bearer {
		return nil, forbidden()
	}
	var input struct {
		SiteName    string `json:"siteName"`
		Mode        string `json:"mode"`
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
		SeedDemo    bool   `json:"seedDemo"`
		StarterPack string `json:"starterPack,omitempty"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	if input.StarterPack != "" {
		if _, err := starterPack(input.StarterPack); err != nil {
			return nil, err
		}
	}
	name, err := required(input.SiteName, "siteName", 80)
	if err != nil {
		return nil, err
	}
	if input.Mode == "" {
		input.Mode = ModePublicRead
	}
	if !validMode(input.Mode) {
		return nil, invalid("Unknown access mode.")
	}
	needOwner := input.Mode != ModeOpenEdit || input.Username != "" || input.Password != "" || input.DisplayName != ""
	var user *User
	if needOwner {
		user, err = a.insertUser(r, accountInput{input.Username, input.DisplayName, input.Password}, "Owner")
		if err != nil {
			return nil, err
		}
	}
	shared, err := a.insertSpace(r, a.localized("共享空间", "Shared"), "shared", "", input.Mode == ModeOpenEdit || input.Mode == ModePublicRead)
	if err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET initialized=?,site_name=?,mode=?,registration_enabled=? WHERE id=1"), true, name, input.Mode, false)
	if err != nil {
		return nil, err
	}
	r.Settings.Initialized = true
	r.Settings.SiteName = name
	r.Settings.Mode = input.Mode
	r.Settings.HasOwner = user != nil
	if input.SeedDemo {
		if err = a.seedStarterPack(r, shared.ID, input.StarterPack); err != nil {
			return nil, err
		}
	}
	if user != nil {
		if err = a.issueSession(r, user); err != nil {
			return nil, err
		}
	}
	return &Response{Status: 201, Data: map[string]any{"initialized": true, "mode": input.Mode, "user": user}}, nil
}

func (a *App) login(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.Bearer {
		return nil, forbidden()
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if _, _, err := validateCredentials(in.Username, in.Username, in.Password); err != nil {
		return nil, unauthorized()
	}
	user, err := scanUser(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+userColumns+" FROM users WHERE normalized_username=?"), strings.ToLower(strings.TrimSpace(in.Username))))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	hash := a.dummyPassword
	if user != nil {
		hash = user.PasswordHash
	}
	passwordOK := verifyPassword(in.Password, hash)
	if !passwordOK || !canLogin(user, r.Settings) {
		return nil, unauthorized()
	}
	if r.SessionToken != "" {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE token_hash=?"), tokenHash(r.SessionToken)); err != nil {
			return nil, err
		}
	}
	if err = a.issueSession(r, user); err != nil {
		return nil, err
	}
	return ok(map[string]any{"user": user}), nil
}

func (a *App) logout(r *Request) (*Response, error) {
	if r.Bearer {
		return nil, forbidden()
	}
	var in struct{}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if r.SessionToken != "" {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE token_hash=?"), tokenHash(r.SessionToken)); err != nil {
			return nil, err
		}
	}
	a.clearSessionCookie(r)
	return ok(map[string]bool{"success": true}), nil
}

func (a *App) register(r *Request) (*Response, error) {
	if r.Bearer || !r.Settings.Initialized || r.Settings.Mode != ModePrivateMulti || !r.Settings.RegistrationEnabled {
		return nil, forbidden()
	}
	var in accountInput
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	user, err := a.insertUser(r, in, "Member")
	if err != nil {
		return nil, err
	}
	if err = a.issueSession(r, user); err != nil {
		return nil, err
	}
	return &Response{Status: 201, Data: user}, nil
}

func (a *App) getSettings(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.Bearer {
		return nil, forbidden()
	}
	if r.Settings.Mode != ModeOpenEdit {
		if err := r.requireOwner(); err != nil {
			return nil, err
		}
	}
	return ok(map[string]any{"siteName": r.Settings.SiteName, "mode": r.Settings.Mode, "registrationEnabled": r.Settings.RegistrationEnabled, "autoFetchIcons": r.Settings.AutoFetchIcons, "autoSelectEndpoint": r.Settings.AutoSelectEndpoint, "hasOwner": r.Settings.HasOwner}), nil
}

func (a *App) updateSettings(r *Request) (*Response, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.Bearer {
		return nil, forbidden()
	}
	var in struct {
		SiteName            string           `json:"siteName"`
		Mode                string           `json:"mode"`
		RegistrationEnabled bool             `json:"registrationEnabled"`
		AutoFetchIcons      optionalIconBool `json:"autoFetchIcons"`
		AutoSelectEndpoint  optionalIconBool `json:"autoSelectEndpoint"`
		Owner               *accountInput    `json:"owner"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	name, err := required(in.SiteName, "siteName", 80)
	if err != nil {
		return nil, err
	}
	if !validMode(in.Mode) {
		return nil, invalid("Unknown access mode.")
	}
	if in.RegistrationEnabled && in.Mode != ModePrivateMulti {
		return nil, invalid("Registration is available only in private_multi mode.")
	}
	securityChanged := in.Mode != r.Settings.Mode || in.RegistrationEnabled != r.Settings.RegistrationEnabled || in.Owner != nil
	autoFetchIcons := r.Settings.AutoFetchIcons
	if in.AutoFetchIcons.present {
		autoFetchIcons = in.AutoFetchIcons.value
	}
	iconsChanged := autoFetchIcons != r.Settings.AutoFetchIcons
	autoSelectEndpoint := r.Settings.AutoSelectEndpoint
	if in.AutoSelectEndpoint.present {
		autoSelectEndpoint = in.AutoSelectEndpoint.value
	}
	navigationChanged := autoSelectEndpoint != r.Settings.AutoSelectEndpoint
	if r.Settings.HasOwner {
		if in.Owner != nil {
			return nil, invalid("The existing Owner cannot be replaced through settings.")
		}
		if securityChanged || iconsChanged || navigationChanged || r.Settings.Mode != ModeOpenEdit {
			if err = r.requireOwner(); err != nil {
				return nil, err
			}
		}
	} else if r.Settings.Mode != ModeOpenEdit {
		return nil, forbidden()
	}
	var owner *User
	if !r.Settings.HasOwner && (in.Owner != nil || in.Mode != ModeOpenEdit) {
		if in.Owner == nil {
			return nil, invalid("Create an Owner before enabling a login mode.")
		}
		owner, err = a.insertUser(r, *in.Owner, "Owner")
		if err != nil {
			return nil, err
		}
	}
	epoch := r.Settings.AuthEpoch
	if securityChanged {
		epoch++
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET site_name=?,mode=?,registration_enabled=?,auth_epoch=?,auto_fetch_icons=?,auto_select_endpoint=? WHERE id=1"), name, in.Mode, in.RegistrationEnabled, epoch, autoFetchIcons, autoSelectEndpoint)
	if err != nil {
		return nil, err
	}
	r.Settings.SiteName = name
	r.Settings.Mode = in.Mode
	r.Settings.RegistrationEnabled = in.RegistrationEnabled
	r.Settings.AuthEpoch = epoch
	r.Settings.AutoFetchIcons = autoFetchIcons
	r.Settings.AutoSelectEndpoint = autoSelectEndpoint
	r.Settings.HasOwner = r.Settings.HasOwner || owner != nil
	if iconsChanged && !autoFetchIcons {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), "DELETE FROM icon_favicon_jobs"); err != nil {
			return nil, err
		}
		r.CancelAutoIcons = true
	}
	if securityChanged {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM icon_favicon_jobs WHERE auth_epoch<>?"), epoch); err != nil {
			return nil, err
		}
		r.CancelAutoIcons = true
		r.WakeAutoIcons = true
	}
	if securityChanged {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), "DELETE FROM sessions"); err != nil {
			return nil, err
		}
		a.clearSessionCookie(r)
		r.User = nil
		r.SessionToken = ""
	}
	if owner != nil {
		if err = a.issueSession(r, owner); err != nil {
			return nil, err
		}
	}
	return ok(map[string]any{"siteName": name, "mode": in.Mode, "registrationEnabled": in.RegistrationEnabled, "autoFetchIcons": autoFetchIcons, "autoSelectEndpoint": autoSelectEndpoint, "hasOwner": r.Settings.HasOwner}), nil
}

func (a *App) requireUserAdmin(r *Request) error {
	if err := r.requireOwner(); err != nil {
		return err
	}
	if r.Settings.Mode != ModePrivateMulti {
		return forbidden()
	}
	return nil
}

func (a *App) listUsers(r *Request) (*Response, error) {
	if err := a.requireUserAdmin(r); err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), "SELECT "+userColumns+" FROM users ORDER BY role,normalized_username")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, *user)
	}
	return ok(users), rows.Err()
}

func (a *App) createUser(r *Request) (*Response, error) {
	if err := a.requireUserAdmin(r); err != nil {
		return nil, err
	}
	var in accountInput
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	user, err := a.insertUser(r, in, "Member")
	if err != nil {
		return nil, err
	}
	return &Response{Status: 201, Data: user}, nil
}

func (a *App) updateUser(r *Request) (*Response, error) {
	if err := a.requireUserAdmin(r); err != nil {
		return nil, err
	}
	user, err := a.loadUser(r.HTTP.Context(), r.Q, r.param("id"))
	if err != nil {
		return nil, storageError(err)
	}
	var in struct {
		DisplayName string  `json:"displayName"`
		IsEnabled   bool    `json:"isEnabled"`
		Password    *string `json:"password"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	name, err := required(in.DisplayName, "displayName", 80)
	if err != nil {
		return nil, err
	}
	if user.Role == "Owner" && !in.IsEnabled {
		return nil, invalid("The Owner cannot be disabled.")
	}
	changed := in.IsEnabled != user.IsEnabled
	if in.Password != nil && *in.Password != "" {
		if _, _, err = validateCredentials(user.Username, name, *in.Password); err != nil {
			return nil, err
		}
		user.PasswordHash, err = hashPassword(*in.Password)
		if err != nil {
			return nil, err
		}
		changed = true
	}
	if changed {
		user.Version++
	}
	user.DisplayName = name
	user.IsEnabled = in.IsEnabled
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE users SET display_name=?,is_enabled=?,password_hash=?,version=? WHERE id=?"), name, user.IsEnabled, user.PasswordHash, user.Version, user.ID)
	if err != nil {
		return nil, err
	}
	if changed {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM sessions WHERE user_id=?"), user.ID); err != nil {
			return nil, err
		}
	}
	return ok(user), nil
}
