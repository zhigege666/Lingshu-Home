package home

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const maxDocumentBytes = 1 << 20
const maxDocumentAssetBytes = 10 << 20
const maxSourceDocuments = 10000
const maxSourceBytes = 128 << 20
const maxDocumentHistory = 20

func insideDocumentPath(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func (c *Config) validateDocumentRoots() error {
	if len(c.DocumentRoots) > 32 {
		return errors.New("at most 32 document roots may be configured")
	}
	seen := map[string]bool{}
	for i, configured := range c.DocumentRoots {
		if !filepath.IsAbs(configured) || strings.ContainsRune(configured, 0) {
			return errors.New("document roots must be absolute directory paths")
		}
		root := filepath.Clean(configured)
		if filepath.Dir(root) == root || seen[root] {
			return errors.New("document roots must be distinct directories, never a filesystem root")
		}
		// A root must never expose Home's keys, database, web assets or TLS keys.
		for _, sensitive := range []string{c.DataDir, c.WebDir, c.TLSCertFile, c.TLSKeyFile} {
			if sensitive == "" {
				continue
			}
			abs, err := filepath.Abs(sensitive)
			if err != nil {
				return err
			}
			if insideDocumentPath(root, abs) || insideDocumentPath(abs, root) {
				return errors.New("document roots must be separate from application data, web assets and TLS files")
			}
			if actual, e := filepath.EvalSymlinks(abs); e == nil && (insideDocumentPath(root, actual) || insideDocumentPath(actual, root)) {
				return errors.New("document roots must be separate from resolved application data and TLS file paths")
			}
		}
		if actual, err := filepath.EvalSymlinks(root); err == nil && actual != root {
			return errors.New("document roots cannot use symbolic links")
		}
		seen[root] = true
		c.DocumentRoots[i] = root
	}
	return nil
}

func cleanDocumentPath(value string, folder bool) (string, error) {
	if folder && value == "" {
		return "", nil
	}
	if value == "" || len(value) > 2048 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00\r\n") || path.IsAbs(value) || strings.Contains(value, ":") {
		return "", invalid("Use a relative path inside the document directory.")
	}
	if path.Clean(value) != value || value == "." {
		return "", invalid("Use a normalized relative path without . or .. segments.")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == "" || strings.HasPrefix(part, ".") || len(part) > 255 {
			return "", invalid("Hidden paths and parent-directory traversal are not allowed.")
		}
	}
	if !folder && !isMarkdownPath(value) {
		return "", invalid("Documents must have a .md or .markdown extension.")
	}
	return value, nil
}

func isMarkdownPath(value string) bool {
	ext := strings.ToLower(path.Ext(value))
	return ext == ".md" || ext == ".markdown"
}

// Open a source through an administrator-configured root. os.Root confines every
// subsequent operation even if another process swaps a path for a symlink.
func (a *App) openDocumentRoot(sourcePath string) (*os.Root, error) {
	for _, allowed := range a.config.DocumentRoots {
		if !insideDocumentPath(allowed, sourcePath) {
			continue
		}
		actual, err := filepath.EvalSymlinks(allowed)
		if err != nil || actual != allowed {
			continue
		}
		anchor, err := os.OpenRoot(allowed)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(allowed, sourcePath)
		if err != nil {
			anchor.Close()
			continue
		}
		if rel == "." {
			return anchor, nil
		}
		if err = noDocumentSymlinks(anchor, filepath.ToSlash(rel), false); err != nil {
			anchor.Close()
			return nil, err
		}
		root, err := anchor.OpenRoot(rel)
		anchor.Close()
		return root, err
	}
	return nil, &APIError{Status: 503, Code: "document_source_unavailable", Message: "The document directory is unavailable or is outside the configured roots. Existing metadata has been retained."}
}

func noDocumentSymlinks(root *os.Root, relative string, allowMissing bool) error {
	parts := strings.Split(relative, "/")
	for i := range parts {
		info, err := root.Lstat(filepath.FromSlash(strings.Join(parts[:i+1], "/")))
		if allowMissing && errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return invalid("Symbolic links are not supported in document directories.")
		}
		if i < len(parts)-1 && !info.IsDir() {
			return invalid("A document path component is not a directory.")
		}
	}
	return nil
}

func readDocumentFile(root *os.Root, relative string, limit int64) ([]byte, fs.FileInfo, error) {
	if err := noDocumentSymlinks(root, relative, false); err != nil {
		return nil, nil, err
	}
	before, err := root.Lstat(filepath.FromSlash(relative))
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, nil, invalid("The file is not a regular file or exceeds the size limit.")
	}
	// O_NONBLOCK prevents an externally swapped FIFO from hanging the request
	// between Lstat and Open. The opened descriptor is checked again below.
	f, err := root.OpenFile(filepath.FromSlash(relative), os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, nil, invalid("The file is not a regular file or exceeds the size limit.")
	}
	body, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(body)) > limit {
		return nil, nil, invalid("The file exceeds the size limit.")
	}
	return body, info, nil
}

func documentHash(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}
func validateDocumentContent(content string) error {
	if len(content) > maxDocumentBytes || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return invalid("Markdown must be valid UTF-8 text, without NUL bytes, at most 1 MiB.")
	}
	return nil
}
func documentTitle(relative string, body []byte) string {
	frontMatter := false
	for i, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
		if i == 0 && line == "---" {
			frontMatter = true
			continue
		}
		if frontMatter {
			if line == "---" || line == "..." {
				frontMatter = false
			}
			continue
		}
		if strings.HasPrefix(line, "# ") {
			title := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line[2:]), " #"))
			if len([]rune(title)) > 160 {
				title = string([]rune(title)[:160])
			}
			if title != "" {
				return title
			}
		}
	}
	return strings.TrimSuffix(path.Base(relative), path.Ext(relative))
}

func documentConflict(revision string) error {
	return &APIError{Status: 409, Code: "document_version_conflict", Message: "The original file changed. Your draft has not been written; reload and compare before saving.", CurrentRevision: revision}
}

// Recovery copies are independent of the SQL transaction: if a DB commit fails
// after a file rename, the old bytes remain recoverable and a later scan repairs
// the derived index. Files remain the authoritative working content.
func (a *App) saveDocumentHistory(sourceID, documentID string, body []byte) error {
	dir := filepath.Join(a.config.DataDir, "document-history", sourceID, documentID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	target := filepath.Join(dir, documentHash(body)+".md")
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, fs.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = f.Write(body)
	if err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err == nil {
		err = closed
	}
	if err != nil {
		_ = os.Remove(target)
		return err
	}
	entries, _ := os.ReadDir(dir)
	type candidate struct {
		name string
		at   time.Time
	}
	files := []candidate{}
	for _, entry := range entries {
		if info, e := entry.Info(); e == nil && info.Mode().IsRegular() && strings.HasSuffix(entry.Name(), ".md") {
			files = append(files, candidate{entry.Name(), info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.After(files[j].at) })
	for _, file := range files[min(len(files), maxDocumentHistory):] {
		_ = os.Remove(filepath.Join(dir, file.name))
	}
	return nil
}

// Compare again immediately before replacing. This coordinates Home writers,
// not arbitrary external programs: an external writer can still race this last
// check. Atomic rename prevents partial Home writes, not universal file CAS.
func writeDocumentFile(root *os.Root, relative, expected string, body []byte) error {
	if err := noDocumentSymlinks(root, relative, true); err != nil {
		return err
	}
	dir := path.Dir(relative)
	if dir != "." {
		if err := root.MkdirAll(filepath.FromSlash(dir), 0750); err != nil {
			return err
		}
	}
	mode := fs.FileMode(0640)
	if expected != "" {
		old, info, err := readDocumentFile(root, relative, maxDocumentBytes)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return documentConflict("")
			}
			return err
		}
		if documentHash(old) != expected {
			return documentConflict(documentHash(old))
		}
		mode = info.Mode().Perm()
	}
	temp := path.Join(dir, ".lingshu-"+newID()+".tmp")
	f, err := root.OpenFile(filepath.FromSlash(temp), os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer root.Remove(filepath.FromSlash(temp))
	_, err = f.Write(body)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if expected == "" {
		// Link is an atomic create-if-absent on the same filesystem: a new file
		// cannot overwrite an external editor's newly created destination.
		if err = root.Link(filepath.FromSlash(temp), filepath.FromSlash(relative)); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return conflict("A file already exists at that path.")
			}
			return err
		}
		return nil
	}
	current, _, err := readDocumentFile(root, relative, maxDocumentBytes)
	if err != nil {
		return err
	}
	if documentHash(current) != expected {
		return documentConflict(documentHash(current))
	}
	return root.Rename(filepath.FromSlash(temp), filepath.FromSlash(relative))
}

func documentFileError(err error) error {
	var api *APIError
	if errors.As(err, &api) {
		return api
	}
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS) {
		return &APIError{Status: 403, Code: "document_file_read_only", Message: "The filesystem denied this operation. Check the mount mode and file ownership."}
	}
	if errors.Is(err, fs.ErrNotExist) {
		return &APIError{Status: 409, Code: "document_file_missing", Message: "The original file is missing. Its metadata and recovery history have been retained."}
	}
	return &APIError{Status: 503, Code: "document_file_unavailable", Message: "The original file could not be accessed. Check the directory and storage connection."}
}

func validDocumentRevision(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func documentHistoryPath(a *App, sourceID, documentID, revision string) (string, error) {
	if !validDocumentRevision(revision) {
		return "", invalid("A valid content revision is required.")
	}
	return filepath.Join(a.config.DataDir, "document-history", sourceID, documentID, revision+".md"), nil
}

func documentFileStatusMessage(err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return "The directory is not readable by the Home process."
	}
	var api *APIError
	if errors.As(err, &api) {
		return api.Message
	}
	return fmt.Sprint("The directory is unavailable. Check its mount and access permissions; no files have been removed from the index.")
}
