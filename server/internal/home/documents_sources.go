package home

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
)

type DocumentSource struct {
	ID                  string `json:"id"`
	SpaceID             string `json:"spaceId"`
	Name                string `json:"name"`
	Path                string `json:"path"`
	ReadOnly            bool   `json:"readOnly"`
	DefaultWrite        bool   `json:"defaultWrite"`
	DefaultFolder       string `json:"defaultFolder"`
	ScanIntervalSeconds int    `json:"scanIntervalSeconds"`
	Enabled             bool   `json:"enabled"`
	Status              string `json:"status"`
	LastScanAt          string `json:"lastScanAt"`
	LastError           string `json:"lastError"`
	Revision            string `json:"revision"`
	DocumentCount       int    `json:"documentCount"`
}

type documentSourceInput struct {
	Name                string `json:"name"`
	Path                string `json:"path,omitempty"`
	ReadOnly            *bool  `json:"readOnly"`
	DefaultWrite        bool   `json:"defaultWrite"`
	DefaultFolder       string `json:"defaultFolder"`
	ScanIntervalSeconds int    `json:"scanIntervalSeconds"`
	Enabled             *bool  `json:"enabled,omitempty"`
	ExpectedRevision    string `json:"expectedRevision,omitempty"`
}

const documentSourceColumns = "id,space_id,name,path,read_only,default_write,default_folder,scan_interval_seconds,enabled,status,last_scan_at,last_error,revision"

func scanDocumentSource(row interface{ Scan(...any) error }) (*DocumentSource, error) {
	s := &DocumentSource{}
	var revision int64
	err := row.Scan(&s.ID, &s.SpaceID, &s.Name, &s.Path, &s.ReadOnly, &s.DefaultWrite, &s.DefaultFolder, &s.ScanIntervalSeconds, &s.Enabled, &s.Status, &s.LastScanAt, &s.LastError, &revision)
	s.Revision = strconv.FormatInt(revision, 10)
	return s, err
}

func (a *App) documentSource(r *Request, id string) (*DocumentSource, error) {
	s, err := scanDocumentSource(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+documentSourceColumns+" FROM document_sources WHERE id=? AND space_id=?"), id, r.param("spaceId")))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	return s, err
}

func (r *Request) documentSpace(write bool) (*Space, bool, error) {
	// Writes return the resulting document. Require both scopes before any
	// filesystem operation so response authorization cannot fail after a save.
	if err := r.requireAction("documents:read"); err != nil {
		return nil, false, err
	}
	action := "documents:read"
	if write {
		action = "documents:write"
	}
	if err := r.requireAction(action); err != nil {
		return nil, false, err
	}
	s, err := r.requireSpace(r.param("spaceId"), write)
	if err != nil {
		return nil, false, err
	}
	_, edit := r.spaceAccess(s)
	// Server files never inherit anonymous open-edit permission.
	edit = edit && r.User != nil
	if write && !edit {
		return nil, false, unauthorized()
	}
	return s, edit, nil
}

func (a *App) registerDocumentRoutes() {
	a.route("GET /api/v1/spaces/{spaceId}/document-sources", false, a.listDocumentSources)
	a.route("POST /api/v1/spaces/{spaceId}/document-sources", true, a.createDocumentSource)
	a.route("PUT /api/v1/spaces/{spaceId}/document-sources/{id}", true, a.updateDocumentSource)
	a.route("DELETE /api/v1/spaces/{spaceId}/document-sources/{id}", true, a.detachDocumentSource)
	a.route("POST /api/v1/spaces/{spaceId}/document-sources/{id}/scan", true, a.rescanDocumentSource)
	a.route("GET /api/v1/spaces/{spaceId}/documents", false, a.listDocuments)
	a.route("POST /api/v1/spaces/{spaceId}/documents", true, a.createDocument)
	a.route("GET /api/v1/spaces/{spaceId}/documents/{id}", false, a.getDocument)
	a.route("PUT /api/v1/spaces/{spaceId}/documents/{id}", true, a.updateDocument)
	a.route("DELETE /api/v1/spaces/{spaceId}/documents/{id}", true, a.deleteDocument)
	a.route("POST /api/v1/spaces/{spaceId}/documents/{id}/rename", true, a.renameDocument)
	a.route("PUT /api/v1/spaces/{spaceId}/documents/{id}/metadata", true, a.updateDocumentMetadata)
	a.route("POST /api/v1/spaces/{spaceId}/documents/{id}/publish", true, a.publishDocument)
	a.route("DELETE /api/v1/spaces/{spaceId}/documents/{id}/publish", true, a.unpublishDocument)
	a.route("GET /api/v1/spaces/{spaceId}/documents/{id}/asset", false, a.getDocumentAsset)
	a.route("GET /api/v1/spaces/{spaceId}/documents/{id}/history", false, a.listDocumentHistory)
	a.route("GET /api/v1/spaces/{spaceId}/documents/{id}/history/{revision}", false, a.getDocumentHistory)
	a.route("POST /api/v1/spaces/{spaceId}/documents/{id}/restore", true, a.restoreDocument)
	a.route("PUT /api/v1/spaces/{spaceId}/links/{id}/context", true, a.updateLinkContext)
}

func (a *App) listDocumentSources(r *Request) (*Response, error) {
	_, edit, err := r.documentSpace(false)
	if err != nil {
		return nil, err
	}
	if r.User == nil {
		return nil, unauthorized()
	}
	canManage := r.User.Role == "Owner" && edit && !r.Bearer
	items := []DocumentSource{}
	// Readers must not learn unpublished directory names, paths or file counts.
	if edit {
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+documentSourceColumns+",(SELECT COUNT(*) FROM documents d WHERE d.source_id=document_sources.id AND d.status='ready') FROM document_sources WHERE space_id=? ORDER BY name,id"), r.param("spaceId"))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			s := DocumentSource{}
			var revision int64
			if err = rows.Scan(&s.ID, &s.SpaceID, &s.Name, &s.Path, &s.ReadOnly, &s.DefaultWrite, &s.DefaultFolder, &s.ScanIntervalSeconds, &s.Enabled, &s.Status, &s.LastScanAt, &s.LastError, &revision, &s.DocumentCount); err != nil {
				return nil, err
			}
			s.Revision = strconv.FormatInt(revision, 10)
			if !canManage {
				s.Path = ""
			}
			items = append(items, s)
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
	}
	roots := []string{}
	if canManage {
		roots = append(roots, a.config.DocumentRoots...)
	}
	return ok(map[string]any{"items": items, "roots": roots, "canManage": canManage}), nil
}

func (a *App) validateDocumentSource(in *documentSourceInput) error {
	var err error
	in.Name, err = required(in.Name, "name", 100)
	if err != nil {
		return err
	}
	if _, err = cleanDocumentPath(in.DefaultFolder, true); err != nil {
		return err
	}
	if in.ScanIntervalSeconds == 0 {
		in.ScanIntervalSeconds = 60
	}
	if in.ScanIntervalSeconds < 10 || in.ScanIntervalSeconds > 86400 {
		return invalid("The scan interval must be between 10 and 86400 seconds.")
	}
	if in.ReadOnly == nil {
		value := true
		in.ReadOnly = &value
	}
	if in.DefaultWrite && *in.ReadOnly {
		return invalid("A read-only directory cannot be the default write directory.")
	}
	return nil
}

func (a *App) sourceManager(r *Request) error {
	if err := r.requireOwner(); err != nil {
		return err
	}
	_, _, err := r.documentSpace(true)
	return err
}

func (a *App) createDocumentSource(r *Request) (*Response, error) {
	if err := a.sourceManager(r); err != nil {
		return nil, err
	}
	var in documentSourceInput
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if err := a.validateDocumentSource(&in); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(in.Path) || filepath.Clean(in.Path) != in.Path {
		return nil, invalid("Enter the absolute container directory configured by Docker.")
	}
	paths := []string{}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), "SELECT path FROM document_sources")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var existing string
		if err = rows.Scan(&existing); err != nil {
			rows.Close()
			return nil, err
		}
		if insideDocumentPath(existing, in.Path) || insideDocumentPath(in.Path, existing) {
			rows.Close()
			return nil, conflict("This directory overlaps an existing registration. Re-enable its existing binding instead of creating a duplicate.")
		}
		paths = append(paths, existing)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(paths) >= 100 {
		return nil, invalid("This instance supports at most 100 registered document directories.")
	}
	source := &DocumentSource{ID: newID(), SpaceID: r.param("spaceId"), Name: in.Name, Path: in.Path, ReadOnly: *in.ReadOnly, DefaultWrite: in.DefaultWrite, DefaultFolder: in.DefaultFolder, ScanIntervalSeconds: in.ScanIntervalSeconds, Enabled: true, Status: "pending", Revision: "1"}
	return &Response{AfterTransaction: func() (*Response, error) {
		root, err := a.openDocumentRoot(source.Path)
		if err != nil {
			return nil, documentFileError(err)
		}
		info, err := root.Stat(".")
		if err == nil {
			for _, existing := range paths {
				if other, e := os.Stat(existing); e == nil && os.SameFile(info, other) {
					err = conflict("This directory already has a binding through another mount path.")
					break
				}
			}
		}
		if err == nil && in.DefaultFolder != "" {
			err = noDocumentSymlinks(root, in.DefaultFolder, true)
		}
		if err == nil && !source.ReadOnly {
			err = probeDocumentWrite(root)
		}
		root.Close()
		if err != nil {
			return nil, documentFileError(err)
		}
		scan := a.collectDocumentDirectory(r.HTTP.Context(), source)
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if source.DefaultWrite {
				if _, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE document_sources SET default_write=?,revision=revision+1 WHERE space_id=? AND default_write=?"), false, source.SpaceID, true); err != nil {
					return nil, err
				}
			}
			_, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("INSERT INTO document_sources("+documentSourceColumns+") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"), source.ID, source.SpaceID, source.Name, source.Path, source.ReadOnly, source.DefaultWrite, source.DefaultFolder, source.ScanIntervalSeconds, source.Enabled, source.Status, "", "", 1)
			if err != nil {
				return nil, err
			}
			if err = a.applyDocumentScan(rr, source, scan, false); err != nil {
				return nil, err
			}
			return &Response{Status: 201, Data: source}, nil
		})
	}}, nil
}

func probeDocumentWrite(root *os.Root) error {
	name := ".lingshu-check-" + newID()
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	closeErr := f.Close()
	removeErr := root.Remove(name)
	if closeErr != nil {
		return closeErr
	}
	return removeErr
}

func (a *App) updateDocumentSource(r *Request) (*Response, error) {
	if err := a.sourceManager(r); err != nil {
		return nil, err
	}
	source, err := a.documentSource(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in documentSourceInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.Path != "" && in.Path != source.Path {
		return nil, invalid("A registered directory path is immutable; configure a separate directory instead.")
	}
	if in.ExpectedRevision != source.Revision {
		return nil, revisionConflict(source.Revision)
	}
	if err = a.validateDocumentSource(&in); err != nil {
		return nil, err
	}
	enabled := source.Enabled
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	if !enabled && in.DefaultWrite {
		return nil, invalid("A detached directory cannot be the default write directory.")
	}
	source.Name = in.Name
	source.ReadOnly = *in.ReadOnly
	source.DefaultWrite = in.DefaultWrite
	source.DefaultFolder = in.DefaultFolder
	source.ScanIntervalSeconds = in.ScanIntervalSeconds
	source.Enabled = enabled
	if enabled {
		source.Status = "pending"
	} else {
		source.Status = "detached"
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		var scan documentScan
		if enabled {
			root, err := a.openDocumentRoot(source.Path)
			if err != nil {
				return nil, documentFileError(err)
			}
			if !source.ReadOnly {
				err = probeDocumentWrite(root)
			}
			if err == nil && source.DefaultFolder != "" {
				err = noDocumentSymlinks(root, source.DefaultFolder, true)
			}
			root.Close()
			if err != nil {
				return nil, documentFileError(err)
			}
			scan = a.collectDocumentDirectory(r.HTTP.Context(), source)
		}
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if source.DefaultWrite {
				if _, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE document_sources SET default_write=?,revision=revision+1 WHERE space_id=? AND id<>? AND default_write=?"), false, source.SpaceID, source.ID, true); err != nil {
					return nil, err
				}
			}
			_, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE document_sources SET name=?,read_only=?,default_write=?,default_folder=?,scan_interval_seconds=?,enabled=?,status=?,revision=revision+1 WHERE id=?"), source.Name, source.ReadOnly, source.DefaultWrite, source.DefaultFolder, source.ScanIntervalSeconds, source.Enabled, source.Status, source.ID)
			if err != nil {
				return nil, err
			}
			revision, _ := strconv.ParseInt(source.Revision, 10, 64)
			source.Revision = strconv.FormatInt(revision+1, 10)
			if enabled {
				if err = a.applyDocumentScan(rr, source, scan, false); err != nil {
					return nil, err
				}
			}
			return ok(source), nil
		})
	}}, nil
}

func (a *App) detachDocumentSource(r *Request) (*Response, error) {
	if err := a.sourceManager(r); err != nil {
		return nil, err
	}
	s, err := a.documentSource(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	if r.HTTP.URL.Query().Get("expectedRevision") != s.Revision {
		return nil, revisionConflict(s.Revision)
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE document_sources SET enabled=?,default_write=?,status='detached',revision=revision+1 WHERE id=?"), false, false, s.ID)
	if err != nil {
		return nil, err
	}
	return &Response{Status: 204}, nil
}

func (a *App) rescanDocumentSource(r *Request) (*Response, error) {
	if err := a.sourceManager(r); err != nil {
		return nil, err
	}
	source, err := a.documentSource(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		ConfirmMissing bool `json:"confirmMissing"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !source.Enabled {
		return nil, conflict("Re-enable this directory before scanning it.")
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		scan := a.collectDocumentDirectory(r.HTTP.Context(), source)
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if err := a.applyDocumentScan(rr, source, scan, in.ConfirmMissing); err != nil {
				return nil, err
			}
			return ok(source), nil
		})
	}}, nil
}
