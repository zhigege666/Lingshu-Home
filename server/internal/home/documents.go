package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Document struct {
	ID                    string             `json:"id"`
	SourceID              string             `json:"sourceId"`
	SpaceID               string             `json:"spaceId"`
	SourceName            string             `json:"sourceName"`
	RelativePath          string             `json:"relativePath"`
	Title                 string             `json:"title"`
	Revision              string             `json:"revision"`
	MetadataRevision      string             `json:"metadataRevision"`
	Size                  int64              `json:"size"`
	UpdatedAt             string             `json:"updatedAt"`
	Status                string             `json:"status"`
	ReadOnly              bool               `json:"readOnly"`
	Published             bool               `json:"published"`
	HasUnpublishedChanges bool               `json:"hasUnpublishedChanges"`
	Tags                  []string           `json:"tags"`
	LinkedBookmarkIDs     []string           `json:"linkedBookmarkIds"`
	Content               *string            `json:"content,omitempty"`
	Links                 []documentBookmark `json:"links,omitempty"`
	UnavailableReason     string             `json:"unavailableReason,omitempty"`
}
type documentBookmark struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}
type documentRecord struct {
	Document
	publishedRevision, publishedContent, publishedTitle, publishedPath, publishedSourceName, publishedAt, publishedTags, publishedBookmarks string
	sourcePath                                                                                                                              string
	sourceReadOnly                                                                                                                          bool
	sourceStatus                                                                                                                            string
}

const documentColumns = "d.id,d.source_id,d.space_id,s.name,d.relative_path,d.title,d.revision,d.size,d.updated_at,d.status,d.tags,d.published_revision,d.published_content,d.published_title,d.published_path,d.published_source_name,d.published_at,d.published_tags,d.published_bookmarks,s.path,s.read_only,s.status,d.metadata_revision"

func scanDocument(row interface{ Scan(...any) error }) (*documentRecord, error) {
	d := &documentRecord{}
	var tags string
	err := row.Scan(&d.ID, &d.SourceID, &d.SpaceID, &d.SourceName, &d.RelativePath, &d.Title, &d.Revision, &d.Size, &d.UpdatedAt, &d.Status, &tags, &d.publishedRevision, &d.publishedContent, &d.publishedTitle, &d.publishedPath, &d.publishedSourceName, &d.publishedAt, &d.publishedTags, &d.publishedBookmarks, &d.sourcePath, &d.sourceReadOnly, &d.sourceStatus, &d.MetadataRevision)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(tags), &d.Tags); err != nil {
		return nil, err
	}
	if d.Tags == nil {
		d.Tags = []string{}
	}
	d.LinkedBookmarkIDs = []string{}
	d.Published = d.publishedRevision != ""
	d.HasUnpublishedChanges = d.Published && (d.Revision != d.publishedRevision || d.RelativePath != d.publishedPath || tags != d.publishedTags)
	return d, nil
}

func (d *documentRecord) publicView() {
	d.Title = d.publishedTitle
	d.RelativePath = d.publishedPath
	d.SourceName = d.publishedSourceName
	d.Revision = d.publishedRevision
	d.Size = int64(len(d.publishedContent))
	d.UpdatedAt = d.publishedAt
	d.Status = "ready"
	d.ReadOnly = true
	d.HasUnpublishedChanges = false
	d.MetadataRevision = ""
	_ = json.Unmarshal([]byte(d.publishedTags), &d.Tags)
	_ = json.Unmarshal([]byte(d.publishedBookmarks), &d.LinkedBookmarkIDs)
	if d.Tags == nil {
		d.Tags = []string{}
	}
	if d.LinkedBookmarkIDs == nil {
		d.LinkedBookmarkIDs = []string{}
	}
}

func (a *App) loadDocument(r *Request, write bool) (*documentRecord, *Space, bool, error) {
	s, edit, err := r.documentSpace(write)
	if err != nil {
		return nil, nil, false, err
	}
	d, err := scanDocument(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+documentColumns+" FROM documents d JOIN document_sources s ON s.id=d.source_id WHERE d.id=? AND d.space_id=? AND s.enabled=?"), r.param("id"), s.ID, true))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, false, missing()
	}
	if err != nil {
		return nil, nil, false, err
	}
	if !edit && !d.Published {
		return nil, nil, false, missing()
	}
	d.ReadOnly = !edit || d.sourceReadOnly || r.Bearer && !r.AllowedActions["documents:write"]
	if !edit {
		d.publicView()
	} else {
		if err = a.loadDocumentRelations(r, []*documentRecord{d}); err != nil {
			return nil, nil, false, err
		}
	}
	return d, s, edit, nil
}

func (a *App) loadDocumentRelations(r *Request, documents []*documentRecord) error {
	if len(documents) == 0 {
		return nil
	}
	byID := map[string]*documentRecord{}
	args := []any{}
	marks := []string{}
	for _, d := range documents {
		byID[d.ID] = d
		args = append(args, d.ID)
		marks = append(marks, "?")
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT document_id,bookmark_id FROM document_bookmarks WHERE document_id IN ("+strings.Join(marks, ",")+") ORDER BY bookmark_id"), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var doc, link string
		if err = rows.Scan(&doc, &link); err != nil {
			return err
		}
		byID[doc].LinkedBookmarkIDs = append(byID[doc].LinkedBookmarkIDs, link)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, d := range documents {
		if d.Published && jsonString(d.LinkedBookmarkIDs) != d.publishedBookmarks {
			d.HasUnpublishedChanges = true
		}
	}
	return nil
}

type documentListInput struct {
	Q                string `json:"q"`
	SourceID         string `json:"sourceId"`
	RelativePath     string `json:"relativePath"`
	LinkedBookmarkID string `json:"linkedBookmarkId"`
	Limit            int    `json:"limit"`
	Offset           int    `json:"offset"`
}

func (a *App) listDocuments(r *Request) (*Response, error) {
	s, edit, err := r.documentSpace(false)
	if err != nil {
		return nil, err
	}
	in := documentListInput{Limit: 100}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Q = q.Get("q")
		in.SourceID = q.Get("sourceId")
		in.RelativePath = q.Get("relativePath")
		in.LinkedBookmarkID = q.Get("linkedBookmarkId")
		if value := q.Get("limit"); value != "" {
			in.Limit, err = strconv.Atoi(value)
			if err != nil {
				return nil, invalid("Invalid result limit.")
			}
		}
		if value := q.Get("offset"); value != "" {
			in.Offset, err = strconv.Atoi(value)
			if err != nil {
				return nil, invalid("Invalid result offset.")
			}
		}
	}
	if in.Limit == 0 {
		in.Limit = 100
	}
	if in.Limit < 1 || in.Limit > 500 || in.Offset < 0 || in.Offset > 1000000 || len(in.Q) > 1024 {
		return nil, invalid("Use a result limit of 1–500 and a bounded search query.")
	}
	where := "d.space_id=? AND s.enabled=?"
	args := []any{s.ID, true}
	if !edit {
		where += " AND d.published_revision<>''"
	}
	if in.SourceID != "" {
		where += " AND d.source_id=?"
		args = append(args, in.SourceID)
	}
	pathColumn, titleColumn, contentColumn, tagsColumn := "d.relative_path", "d.title", "d.search_text", "d.tags"
	if !edit {
		pathColumn, titleColumn, contentColumn, tagsColumn = "d.published_path", "d.published_title", "d.published_content", "d.published_tags"
	}
	if in.RelativePath != "" {
		if _, err = cleanDocumentPath(in.RelativePath, false); err != nil {
			return nil, err
		}
		where += " AND " + pathColumn + "=?"
		args = append(args, in.RelativePath)
	}
	if in.LinkedBookmarkID != "" {
		if err = r.requireAction("navigation:read"); err != nil {
			return nil, err
		}
		if !validID(in.LinkedBookmarkID) {
			return nil, invalid("Invalid bookmark ID.")
		}
		if edit {
			where += " AND EXISTS(SELECT 1 FROM document_bookmarks b WHERE b.document_id=d.id AND b.bookmark_id=?)"
			args = append(args, in.LinkedBookmarkID)
		} else {
			where += " AND d.published_bookmarks LIKE ?"
			args = append(args, "%\""+in.LinkedBookmarkID+"\"%")
		}
	}
	if q := strings.TrimSpace(in.Q); q != "" {
		escaped := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(q))
		pattern := "%" + escaped + "%"
		where += " AND (LOWER(" + titleColumn + ") LIKE ? ESCAPE '!' OR LOWER(" + pathColumn + ") LIKE ? ESCAPE '!' OR LOWER(" + contentColumn + ") LIKE ? ESCAPE '!' OR LOWER(" + tagsColumn + ") LIKE ? ESCAPE '!')"
		args = append(args, pattern, pattern, pattern, pattern)
	}
	from := " FROM documents d JOIN document_sources s ON s.id=d.source_id WHERE " + where
	var total int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*)"+from), args...).Scan(&total); err != nil {
		return nil, err
	}
	order := "d.updated_at"
	if !edit {
		order = "d.published_at"
	}
	queryArgs := append(append([]any{}, args...), in.Limit, in.Offset)
	// Lists project metadata only: do not allocate hundreds of complete working
	// and published bodies merely to return a small page of search results.
	columns := strings.Replace(documentColumns, "d.published_content", "''", 1)
	if !edit {
		size := "LENGTH(CAST(d.published_content AS BLOB))"
		if a.store.Provider == "postgres" {
			size = "OCTET_LENGTH(d.published_content)"
		}
		columns = strings.Replace(columns, "d.size", size, 1)
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+columns+from+" ORDER BY "+order+" DESC,d.id LIMIT ? OFFSET ?"), queryArgs...)
	if err != nil {
		return nil, err
	}
	records := []*documentRecord{}
	for rows.Next() {
		d, e := scanDocument(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		if !edit {
			publishedSize := d.Size
			d.publicView()
			d.Size = publishedSize
		} else {
			d.ReadOnly = d.sourceReadOnly || r.Bearer && !r.AllowedActions["documents:write"]
			if d.sourceStatus == "offline" {
				d.ReadOnly = true
				d.UnavailableReason = "source_unavailable"
			}
		}
		records = append(records, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if edit {
		if err = a.loadDocumentRelations(r, records); err != nil {
			return nil, err
		}
	}
	items := make([]Document, 0, len(records))
	for _, d := range records {
		if r.Bearer && !r.AllowedActions["navigation:read"] {
			d.LinkedBookmarkIDs = []string{}
		}
		items = append(items, d.Document)
	}
	return ok(map[string]any{"items": items, "total": total, "limit": in.Limit, "offset": in.Offset}), nil
}

func (a *App) addDocumentLinkDetails(r *Request, d *documentRecord) error {
	d.Links = []documentBookmark{}
	if r.Bearer && !r.AllowedActions["navigation:read"] {
		d.LinkedBookmarkIDs = []string{}
		return nil
	}
	if len(d.LinkedBookmarkIDs) == 0 {
		return nil
	}
	args := []any{d.SpaceID}
	marks := []string{}
	for _, id := range d.LinkedBookmarkIDs {
		args = append(args, id)
		marks = append(marks, "?")
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,title,url FROM links WHERE space_id=? AND id IN ("+strings.Join(marks, ",")+") ORDER BY title,id"), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		link := documentBookmark{}
		if err = rows.Scan(&link.ID, &link.Title, &link.URL); err != nil {
			return err
		}
		d.Links = append(d.Links, link)
	}
	return rows.Err()
}

func (a *App) getDocument(r *Request) (*Response, error) {
	return a.documentResponse(r, 200)
}

// Load authorization and related bookmarks while the database snapshot is open.
// Reading the original file is deferred until that transaction has been released.
func (a *App) documentResponse(r *Request, status int) (*Response, error) {
	d, _, edit, err := a.loadDocument(r, false)
	if err != nil {
		return nil, err
	}
	if err = a.addDocumentLinkDetails(r, d); err != nil {
		return nil, err
	}
	if !edit {
		content := d.publishedContent
		d.Content = &content
		return &Response{Status: status, Data: d.Document}, nil
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		content := ""
		root, e := a.openDocumentRoot(d.sourcePath)
		if e != nil {
			d.ReadOnly = true
			d.UnavailableReason = "source_unavailable"
		} else {
			body, info, e := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
			root.Close()
			if errors.Is(e, fs.ErrNotExist) {
				d.Status = "missing"
			} else if e != nil {
				d.ReadOnly = true
				d.UnavailableReason = "file_unavailable"
			} else if validateDocumentContent(string(body)) != nil {
				d.ReadOnly = true
				d.UnavailableReason = "unsupported_content"
			} else {
				content = string(body)
				d.Revision = documentHash(body)
				d.Title = documentTitle(d.RelativePath, body)
				d.Size = int64(len(body))
				d.UpdatedAt = info.ModTime().UTC().Format(time.RFC3339Nano)
				d.Status = "ready"
				d.HasUnpublishedChanges = d.Published && (d.HasUnpublishedChanges || d.Revision != d.publishedRevision)
			}
		}
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		d.Content = &content
		return &Response{Status: status, Data: d.Document}, nil
	}}, nil
}

func (a *App) createDocument(r *Request) (*Response, error) {
	space, _, err := r.documentSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		SourceID     string  `json:"sourceId"`
		RelativePath string  `json:"relativePath"`
		Content      *string `json:"content"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	useDefault := in.SourceID == ""
	if useDefault {
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM document_sources WHERE space_id=? AND enabled=? AND default_write=?"), space.ID, true, true).Scan(&in.SourceID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, invalid("Choose a writable directory or configure the space's default write directory.")
		}
		if err != nil {
			return nil, err
		}
	}
	source, err := a.documentSource(r, in.SourceID)
	if err != nil {
		return nil, err
	}
	if !source.Enabled {
		return nil, missing()
	}
	if source.ReadOnly {
		return nil, forbidden()
	}
	if _, err = cleanDocumentPath(in.RelativePath, false); err != nil {
		return nil, err
	}
	if useDefault && source.DefaultFolder != "" {
		in.RelativePath = path.Join(source.DefaultFolder, in.RelativePath)
		if _, err = cleanDocumentPath(in.RelativePath, false); err != nil {
			return nil, err
		}
	}
	if in.Content == nil {
		return nil, invalid("content is required; use an explicit empty string to clear it.")
	}
	if err = validateDocumentContent(*in.Content); err != nil {
		return nil, err
	}
	body := []byte(*in.Content)
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, err := a.openDocumentRoot(source.Path)
		if err != nil {
			return nil, documentFileError(err)
		}
		defer root.Close()
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		if err = writeDocumentFile(root, in.RelativePath, "", body); err != nil {
			return nil, documentFileError(err)
		}
		r.DocumentFileChanged = true
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if err := a.indexDocument(rr, source, in.RelativePath, body, nowUTC()); err != nil {
				return nil, err
			}
			var id string
			if err := rr.Q.QueryRowContext(rr.HTTP.Context(), a.store.Query("SELECT id FROM documents WHERE source_id=? AND relative_path=?"), source.ID, in.RelativePath).Scan(&id); err != nil {
				return nil, err
			}
			rr.Params = map[string]string{"spaceId": space.ID, "id": id}
			return a.documentResponse(rr, 201)
		})
	}}, nil
}

// This helper only reads SQL metadata. Call openCurrentDocument after the
// original transaction has been committed, never while holding its connection.
func (a *App) currentDocumentForWrite(r *Request) (*documentRecord, error) {
	d, _, _, err := a.loadDocument(r, true)
	if err != nil {
		return nil, err
	}
	if d.sourceReadOnly {
		return nil, &APIError{Status: 403, Code: "document_source_read_only", Message: "This directory is configured as read-only."}
	}
	return d, nil
}

func (a *App) openCurrentDocument(d *documentRecord) (*os.Root, []byte, error) {
	root, err := a.openDocumentRoot(d.sourcePath)
	if err != nil {
		return nil, nil, documentFileError(err)
	}
	body, _, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
	if err != nil {
		root.Close()
		return nil, nil, documentFileError(err)
	}
	return root, body, nil
}

func (a *App) updateDocument(r *Request) (*Response, error) {
	var in struct {
		Content          *string `json:"content"`
		ExpectedRevision string  `json:"expectedRevision"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if in.Content == nil {
		return nil, invalid("content is required; use an explicit empty string to clear it.")
	}
	if err := validateDocumentContent(*in.Content); err != nil {
		return nil, err
	}
	d, err := a.currentDocumentForWrite(r)
	if err != nil {
		return nil, err
	}
	body := []byte(*in.Content)
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, old, err := a.openCurrentDocument(d)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		if !validDocumentRevision(in.ExpectedRevision) || documentHash(old) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(old))
		}
		if string(old) != *in.Content {
			if err = r.HTTP.Context().Err(); err != nil {
				return nil, err
			}
			if err = a.saveDocumentHistory(d.SourceID, d.ID, old); err != nil {
				return nil, documentFileError(err)
			}
			if err = r.HTTP.Context().Err(); err != nil {
				return nil, err
			}
			if err = writeDocumentFile(root, d.RelativePath, in.ExpectedRevision, body); err != nil {
				return nil, documentFileError(err)
			}
			r.DocumentFileChanged = true
		}
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if err := a.indexDocument(rr, &DocumentSource{ID: d.SourceID, SpaceID: d.SpaceID}, d.RelativePath, body, nowUTC()); err != nil {
				return nil, err
			}
			return a.getDocument(rr)
		})
	}}, nil
}

func (a *App) renameDocument(r *Request) (*Response, error) {
	var in struct {
		RelativePath     string `json:"relativePath"`
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if _, err := cleanDocumentPath(in.RelativePath, false); err != nil {
		return nil, err
	}
	d, err := a.currentDocumentForWrite(r)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM documents WHERE source_id=? AND relative_path=? AND id<>?)"), d.SourceID, in.RelativePath, d.ID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("That path already has a document record. Restore or choose another path.")
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, body, err := a.openCurrentDocument(d)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		if !validDocumentRevision(in.ExpectedRevision) || documentHash(body) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(body))
		}
		if d.RelativePath == in.RelativePath {
			return a.documentTransaction(r, a.getDocument)
		}
		if err = noDocumentSymlinks(root, in.RelativePath, true); err != nil {
			return nil, documentFileError(err)
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		if dir := path.Dir(in.RelativePath); dir != "." {
			if err = root.MkdirAll(filepath.FromSlash(dir), 0750); err != nil {
				return nil, documentFileError(err)
			}
		}
		if err = a.saveDocumentHistory(d.SourceID, d.ID, body); err != nil {
			return nil, documentFileError(err)
		}
		current, _, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		if err != nil {
			return nil, documentFileError(err)
		}
		if documentHash(current) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(current))
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		// Link+unlink cannot replace an existing destination. Mark the file
		// side effect after link succeeds, including a later unlink failure.
		if err = root.Link(filepath.FromSlash(d.RelativePath), filepath.FromSlash(in.RelativePath)); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return nil, conflict("A file already exists at the new path.")
			}
			return nil, documentFileError(err)
		}
		r.DocumentFileChanged = true
		if err = root.Remove(filepath.FromSlash(d.RelativePath)); err != nil {
			return nil, documentFileError(err)
		}
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			_, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE documents SET relative_path=?,title=?,updated_at=? WHERE id=?"), in.RelativePath, documentTitle(in.RelativePath, body), nowUTC(), d.ID)
			if err != nil {
				return nil, err
			}
			return a.getDocument(rr)
		})
	}}, nil
}

func (a *App) deleteDocument(r *Request) (*Response, error) {
	var in struct {
		ExpectedRevision string `json:"expectedRevision"`
	}
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		in.ExpectedRevision = r.HTTP.URL.Query().Get("expectedRevision")
	}
	d, err := a.currentDocumentForWrite(r)
	if err != nil {
		return nil, err
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, body, err := a.openCurrentDocument(d)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		if !validDocumentRevision(in.ExpectedRevision) || documentHash(body) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(body))
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		if err = a.saveDocumentHistory(d.SourceID, d.ID, body); err != nil {
			return nil, documentFileError(err)
		}
		current, _, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		if err != nil {
			return nil, documentFileError(err)
		}
		if documentHash(current) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(current))
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		if err = root.Remove(filepath.FromSlash(d.RelativePath)); err != nil {
			return nil, documentFileError(err)
		}
		r.DocumentFileChanged = true
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			_, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE documents SET status='missing',published_revision='',published_content='',published_title='',published_path='',published_source_name='',published_at='',published_tags='[]',published_bookmarks='[]' WHERE id=?"), d.ID)
			if err != nil {
				return nil, err
			}
			if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("DELETE FROM document_published_assets WHERE document_id=?"), d.ID); err != nil {
				return nil, err
			}
			return a.getDocument(rr)
		})
	}}, nil
}

func (a *App) updateDocumentMetadata(r *Request) (*Response, error) {
	d, _, _, err := a.loadDocument(r, true)
	if err != nil {
		return nil, err
	}
	var in struct {
		Tags                     []string `json:"tags"`
		LinkedBookmarkIDs        []string `json:"linkedBookmarkIds"`
		ExpectedRevision         string   `json:"expectedRevision"`
		ExpectedMetadataRevision string   `json:"expectedMetadataRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ExpectedMetadataRevision != d.MetadataRevision {
		return nil, &APIError{Status: 409, Code: "document_metadata_conflict", Message: "The tags or related bookmarks changed. Reload them before saving.", CurrentRevision: d.MetadataRevision}
	}
	if in.Tags == nil || in.LinkedBookmarkIDs == nil {
		return nil, invalid("tags and linkedBookmarkIds are required arrays; use [] to clear them.")
	}
	if len(in.Tags) > 32 || len(in.LinkedBookmarkIDs) > 100 {
		return nil, invalid("Use at most 32 tags and 100 linked bookmarks.")
	}
	if err = r.requireAction("navigation:read"); err != nil && (len(in.LinkedBookmarkIDs) > 0 || len(d.LinkedBookmarkIDs) > 0) {
		return nil, err
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, tag := range in.Tags {
		tag, err = required(tag, "tag", 40)
		if err != nil {
			return nil, err
		}
		if !seen[tag] {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	ids := []string{}
	seen = map[string]bool{}
	for _, id := range in.LinkedBookmarkIDs {
		if !validID(id) {
			return nil, invalid("Invalid related bookmark ID.")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, err := a.openDocumentRoot(d.sourcePath)
		if err != nil {
			return nil, &APIError{Status: 503, Code: "document_source_unavailable", Message: "The document directory is unavailable. Existing metadata has been retained."}
		}
		body, info, readErr := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		root.Close()
		missingFile := errors.Is(readErr, fs.ErrNotExist)
		if missingFile && d.sourceStatus == "offline" {
			return nil, &APIError{Status: 503, Code: "document_source_unavailable", Message: "The document directory is offline. Restore its connection and rescan before changing metadata."}
		}
		if readErr != nil && !missingFile {
			return nil, documentFileError(readErr)
		}
		revision := d.Revision
		modified := ""
		if !missingFile {
			if err := validateDocumentContent(string(body)); err != nil {
				return nil, err
			}
			revision = documentHash(body)
			modified = info.ModTime().UTC().Format(time.RFC3339Nano)
		}
		if in.ExpectedRevision != revision {
			return nil, documentConflict(revision)
		}
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			current, _, _, err := a.loadDocument(rr, true)
			if err != nil {
				return nil, err
			}
			if in.ExpectedMetadataRevision != current.MetadataRevision {
				return nil, &APIError{Status: 409, Code: "document_metadata_conflict", Message: "The tags or related bookmarks changed. Reload them before saving.", CurrentRevision: current.MetadataRevision}
			}
			if missingFile && in.ExpectedRevision != current.Revision {
				return nil, documentConflict(current.Revision)
			}
			if err = rr.requireAction("navigation:read"); err != nil && (len(ids) > 0 || len(current.LinkedBookmarkIDs) > 0) {
				return nil, err
			}
			// Navigation can change while the file is being read. Validate links
			// in the same short transaction that installs the relationships.
			for _, id := range ids {
				var exists bool
				if err = rr.Q.QueryRowContext(rr.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM links WHERE id=? AND space_id=?)"), id, current.SpaceID).Scan(&exists); err != nil {
					return nil, err
				}
				if !exists {
					return nil, invalid("Related bookmarks must belong to this space.")
				}
			}
			if !missingFile {
				if err = a.indexDocument(rr, &DocumentSource{ID: current.SourceID, SpaceID: current.SpaceID}, current.RelativePath, body, modified); err != nil {
					return nil, err
				}
			}
			if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE documents SET tags=?,metadata_revision=metadata_revision+1 WHERE id=?"), jsonString(tags), current.ID); err != nil {
				return nil, err
			}
			if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("DELETE FROM document_bookmarks WHERE document_id=?"), current.ID); err != nil {
				return nil, err
			}
			for _, id := range ids {
				if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("INSERT INTO document_bookmarks(document_id,bookmark_id) VALUES(?,?)"), current.ID, id); err != nil {
					return nil, err
				}
			}
			return a.getDocument(rr)
		})
	}}, nil
}

type documentHistoryEntry struct {
	Revision  string `json:"revision"`
	CreatedAt string `json:"createdAt"`
	Size      int64  `json:"size"`
}

func (a *App) historyDocument(r *Request) (*documentRecord, error) {
	d, _, edit, err := a.loadDocument(r, false)
	if err != nil {
		return nil, err
	}
	if !edit {
		return nil, missing()
	}
	return d, nil
}
func (a *App) listDocumentHistory(r *Request) (*Response, error) {
	d, err := a.historyDocument(r)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(a.config.DataDir, "document-history", d.SourceID, d.ID)
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		items := []documentHistoryEntry{}
		for _, entry := range entries {
			if err = r.HTTP.Context().Err(); err != nil {
				return nil, err
			}
			revision := strings.TrimSuffix(entry.Name(), ".md")
			if !validDocumentRevision(revision) || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			if info, e := entry.Info(); e == nil && info.Mode().IsRegular() {
				items = append(items, documentHistoryEntry{revision, info.ModTime().UTC().Format(time.RFC3339Nano), info.Size()})
			}
		}
		sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt > items[j].CreatedAt })
		return ok(map[string]any{"items": items}), nil
	}}, nil
}
func (a *App) getDocumentHistory(r *Request) (*Response, error) {
	d, err := a.historyDocument(r)
	if err != nil {
		return nil, err
	}
	revision := r.param("revision")
	file, err := documentHistoryPath(a, d.SourceID, d.ID, revision)
	if err != nil {
		return nil, err
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		body, err := readDocumentHistoryFile(file)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, missing()
		}
		if err != nil {
			return nil, err
		}
		if documentHash(body) != revision {
			return nil, conflict("The recovery copy is invalid.")
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		return ok(map[string]any{"revision": revision, "content": string(body)}), nil
	}}, nil
}

func readDocumentHistoryFile(file string) ([]byte, error) {
	root, err := os.OpenRoot(filepath.Dir(file))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	body, _, err := readDocumentFile(root, filepath.Base(file), maxDocumentBytes)
	return body, err
}
func (a *App) restoreDocument(r *Request) (*Response, error) {
	d, err := a.currentDocumentForWrite(r)
	if err != nil {
		return nil, err
	}
	var in struct {
		Revision         string `json:"revision"`
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	file, err := documentHistoryPath(a, d.SourceID, d.ID, in.Revision)
	if err != nil {
		return nil, err
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		body, err := readDocumentHistoryFile(file)
		if err != nil {
			return nil, documentFileError(err)
		}
		if documentHash(body) != in.Revision {
			return nil, conflict("The recovery copy is invalid.")
		}
		root, err := a.openDocumentRoot(d.sourcePath)
		if err != nil {
			return nil, documentFileError(err)
		}
		defer root.Close()
		old, _, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		expected := in.ExpectedRevision
		if errors.Is(err, fs.ErrNotExist) {
			if in.ExpectedRevision != d.Revision {
				return nil, documentConflict(d.Revision)
			}
			expected = ""
		} else if err != nil {
			return nil, documentFileError(err)
		} else {
			if !validDocumentRevision(expected) || documentHash(old) != expected {
				return nil, documentConflict(documentHash(old))
			}
			if err = r.HTTP.Context().Err(); err != nil {
				return nil, err
			}
			if err = a.saveDocumentHistory(d.SourceID, d.ID, old); err != nil {
				return nil, err
			}
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		if err = writeDocumentFile(root, d.RelativePath, expected, body); err != nil {
			return nil, documentFileError(err)
		}
		r.DocumentFileChanged = true
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if err := a.indexDocument(rr, &DocumentSource{ID: d.SourceID, SpaceID: d.SpaceID}, d.RelativePath, body, nowUTC()); err != nil {
				return nil, err
			}
			return a.getDocument(rr)
		})
	}}, nil
}

func revisionConflict(revision string) error {
	return &APIError{Status: 409, Code: "document_source_version_conflict", Message: "This directory configuration changed. Reload it before saving.", CurrentRevision: revision}
}
