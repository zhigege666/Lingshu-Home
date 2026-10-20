package home

import (
	"database/sql"
	"errors"
)

func (r *Request) requireAction(action string) error {
	if r.Bearer && !r.AllowedActions[action] {
		return forbidden()
	}
	return nil
}

func (r *Request) requireOwner() error {
	if r.User == nil {
		return unauthorized()
	}
	if r.Bearer || r.User.Role != "Owner" {
		return forbidden()
	}
	return nil
}

func (r *Request) requireInitialized() error {
	if !r.Settings.Initialized {
		return &APIError{Status: 409, Code: "setup_required", Message: "Initialize the instance first."}
	}
	return nil
}

func scanSpace(row interface{ Scan(...any) error }) (*Space, error) {
	s := &Space{}
	var owner sql.NullString
	var updated databaseTime
	err := row.Scan(&s.ID, &s.Name, &s.Kind, &owner, &s.Published, &s.DataRevision, &updated)
	if err != nil {
		return nil, err
	}
	s.OwnerUserID = owner.String
	s.UpdatedAt = updated.String()
	return s, nil
}

const spaceColumns = "id,name,kind,owner_user_id,published,data_revision,updated_at"

func (r *Request) spaceAccess(s *Space) (read, write bool) {
	if !r.Settings.Initialized {
		return false, false
	}
	if r.Bearer && r.TokenSpaceID != s.ID {
		return false, false
	}
	if r.User == nil {
		read = s.Kind == "shared" && s.Published && (r.Settings.Mode == ModeOpenEdit || r.Settings.Mode == ModePublicRead)
		return read, read && r.Settings.Mode == ModeOpenEdit
	}
	if !canLogin(r.User, r.Settings) {
		return false, false
	}
	if s.Kind == "personal" {
		own := s.OwnerUserID == r.User.ID
		return own, own
	}
	return true, r.User.Role == "Owner"
}

func (r *Request) requireSpace(id string, write bool) (*Space, error) {
	if err := r.requireInitialized(); err != nil {
		return nil, err
	}
	if r.User == nil && r.Settings.Mode != ModeOpenEdit && r.Settings.Mode != ModePublicRead {
		return nil, unauthorized()
	}
	if !validID(id) {
		return nil, missing()
	}
	s, err := scanSpace(r.Q.QueryRowContext(r.HTTP.Context(), r.App.store.Query("SELECT "+spaceColumns+" FROM spaces WHERE id=?"), id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	read, edit := r.spaceAccess(s)
	if !read {
		return nil, missing()
	}
	if write && !edit {
		if r.User == nil {
			return nil, unauthorized()
		}
		return nil, forbidden()
	}
	s.CanEdit = edit && (!r.Bearer || r.AllowedActions["navigation:write"] || r.AllowedActions["pages:write"])
	return s, nil
}

func (r *Request) navigationSpace(id string, write bool) (*Space, error) {
	action := "navigation:read"
	if write {
		action = "navigation:write"
	}
	if err := r.requireAction(action); err != nil {
		return nil, err
	}
	return r.requireSpace(id, write)
}

func (a *App) accessibleSpaces(r *Request) ([]Space, error) {
	spaces := []Space{}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), "SELECT "+spaceColumns+" FROM spaces ORDER BY kind,name,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		s, err := scanSpace(rows)
		if err != nil {
			return nil, err
		}
		if read, write := r.spaceAccess(s); read {
			s.CanEdit = write && (!r.Bearer || r.AllowedActions["navigation:write"] || r.AllowedActions["pages:write"])
			spaces = append(spaces, *s)
		}
	}
	return spaces, rows.Err()
}
