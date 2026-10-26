package home

import (
	"database/sql"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Parse Markdown links with the same CommonMark rules used by the reader. Raw
// HTML is not rendered by the UI and never grants access to an attachment.
func documentAssetReferences(content []byte) map[string]bool {
	refs := map[string]bool{}
	root := goldmark.DefaultParser().Parse(text.NewReader(content))
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination []byte
		switch value := node.(type) {
		case *ast.Image:
			destination = value.Destination
		case *ast.Link:
			destination = value.Destination
		}
		if len(destination) == 0 {
			return ast.WalkContinue, nil
		}
		value := string(util.URLEscape(destination, true))
		u, err := url.Parse(value)
		if err != nil || u.IsAbs() || u.Host != "" || u.Path == "" || strings.HasPrefix(value, "//") {
			return ast.WalkContinue, nil
		}
		if !isMarkdownPath(u.Path) {
			refs[u.Path] = true
		}
		return ast.WalkContinue, nil
	})
	return refs
}

func resolveDocumentAsset(documentPath, relative string) (string, error) {
	if relative == "" || len(relative) > 2048 || strings.ContainsAny(relative, "\\\x00\r\n") || strings.Contains(relative, ":") || path.IsAbs(relative) {
		return "", invalid("Use an attachment path relative to this document.")
	}
	resolved := path.Clean(path.Join(path.Dir(documentPath), relative))
	if _, err := cleanDocumentPath(resolved, true); err != nil {
		return "", err
	}
	if isMarkdownPath(resolved) {
		return "", invalid("Read Markdown through its document endpoint.")
	}
	return resolved, nil
}

func documentAssetMIME(body []byte) string {
	value := http.DetectContentType(body)
	switch value {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon":
		return value
	}
	// SVG, HTML, scripts, PDF and arbitrary attachments are downloads. Do not
	// allow active content to execute with Home's origin or session cookies.
	return "application/octet-stream"
}

func (a *App) publishDocument(r *Request) (*Response, error) {
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	d, space, _, err := a.loadDocument(r, true)
	if err != nil {
		return nil, err
	}
	if space.Kind != "shared" {
		return nil, invalid("Personal documents cannot be published.")
	}
	var in struct {
		ExpectedRevision         string `json:"expectedRevision"`
		ExpectedMetadataRevision string `json:"expectedMetadataRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ExpectedMetadataRevision != d.MetadataRevision {
		return nil, &APIError{Status: 409, Code: "document_metadata_conflict", Message: "The document's tags or related bookmarks changed. Review them before publishing.", CurrentRevision: d.MetadataRevision}
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, err := a.openDocumentRoot(d.sourcePath)
		if err != nil {
			return nil, documentFileError(err)
		}
		defer root.Close()
		body, info, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		if err != nil {
			return nil, documentFileError(err)
		}
		if !validDocumentRevision(in.ExpectedRevision) || documentHash(body) != in.ExpectedRevision {
			return nil, documentConflict(documentHash(body))
		}
		if err = validateDocumentContent(string(body)); err != nil {
			return nil, err
		}
		refs := documentAssetReferences(body)
		if len(refs) > 100 {
			return nil, invalid("A published document can reference at most 100 local attachments.")
		}
		type asset struct {
			relative, mime string
			body           []byte
		}
		assets := []asset{}
		total := 0
		for relative := range refs {
			if err = r.HTTP.Context().Err(); err != nil {
				return nil, err
			}
			resolved, e := resolveDocumentAsset(d.RelativePath, relative)
			if e != nil {
				return nil, e
			}
			value, _, e := readDocumentFile(root, resolved, maxDocumentAssetBytes)
			if e != nil {
				return nil, &APIError{Status: 409, Code: "document_attachment_unavailable", Message: "A referenced attachment could not be included. Repair its path or permissions before publishing."}
			}
			total += len(value)
			if total > 20<<20 {
				return nil, invalid("Published attachments must total at most 20 MiB per document.")
			}
			assets = append(assets, asset{relative, documentAssetMIME(value), value})
		}
		return a.documentTransaction(r, func(rr *Request) (*Response, error) {
			if err := a.recordObservedDocumentChange(rr, d, documentHash(body)); err != nil {
				return nil, err
			}
			if err := a.indexDocument(rr, &DocumentSource{ID: d.SourceID, SpaceID: d.SpaceID}, d.RelativePath, body, info.ModTime().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")); err != nil {
				return nil, err
			}
			_, err := rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("UPDATE documents SET published_revision=?,published_content=?,published_title=?,published_path=?,published_source_name=?,published_at=?,published_tags=?,published_bookmarks=? WHERE id=?"), documentHash(body), string(body), documentTitle(d.RelativePath, body), d.RelativePath, d.SourceName, nowUTC(), jsonString(d.Tags), jsonString(d.LinkedBookmarkIDs), d.ID)
			if err != nil {
				return nil, err
			}
			if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("DELETE FROM document_published_assets WHERE document_id=?"), d.ID); err != nil {
				return nil, err
			}
			for _, asset := range assets {
				if _, err = rr.Q.ExecContext(rr.HTTP.Context(), a.store.Query("INSERT INTO document_published_assets(document_id,path,mime_type,content) VALUES(?,?,?,?)"), d.ID, asset.relative, asset.mime, asset.body); err != nil {
					return nil, err
				}
			}
			return a.getDocument(rr)
		})
	}}, nil
}

func (a *App) unpublishDocument(r *Request) (*Response, error) {
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	d, _, _, err := a.loadDocument(r, true)
	if err != nil {
		return nil, err
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE documents SET published_revision='',published_content='',published_title='',published_path='',published_source_name='',published_at='',published_tags='[]',published_bookmarks='[]' WHERE id=?"), d.ID); err != nil {
		return nil, err
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM document_published_assets WHERE document_id=?"), d.ID); err != nil {
		return nil, err
	}
	return a.getDocument(r)
}

func (a *App) getDocumentAsset(r *Request) (*Response, error) {
	d, _, edit, err := a.loadDocument(r, false)
	if err != nil {
		return nil, err
	}
	relative := r.HTTP.URL.Query().Get("path")
	resolved, err := resolveDocumentAsset(d.RelativePath, relative)
	if err != nil {
		return nil, err
	}
	if !edit {
		var body []byte
		var mimeType string
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT mime_type,content FROM document_published_assets WHERE document_id=? AND path=?"), d.ID, relative).Scan(&mimeType, &body)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, missing()
		}
		if err != nil {
			return nil, err
		}
		return documentAssetResponse(r, relative, body, mimeType), nil
	}
	return &Response{AfterTransaction: func() (*Response, error) {
		if err := r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		root, err := a.openDocumentRoot(d.sourcePath)
		if err != nil {
			return nil, documentFileError(err)
		}
		defer root.Close()
		content, _, err := readDocumentFile(root, d.RelativePath, maxDocumentBytes)
		if err != nil {
			return nil, documentFileError(err)
		}
		if !documentAssetReferences(content)[relative] {
			return nil, missing()
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		body, _, err := readDocumentFile(root, resolved, maxDocumentAssetBytes)
		if err != nil {
			return nil, documentFileError(err)
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		return documentAssetResponse(r, relative, body, documentAssetMIME(body)), nil
	}}, nil
}

func documentAssetResponse(r *Request, relative string, body []byte, mimeType string) *Response {
	if r.Writer != nil {
		disposition := "attachment"
		if strings.HasPrefix(mimeType, "image/") {
			disposition = "inline"
		}
		r.Writer.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(relative)}))
		r.Writer.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		r.Writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	}
	return &Response{Status: 200, Body: body, ContentType: mimeType}
}
