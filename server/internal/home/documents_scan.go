package home

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

type scannedDocument struct {
	relative string
	body     []byte
	modified string
}
type documentScan struct {
	found           []scannedDocument
	seen            map[string]bool
	directories     []string
	status, message string
	skipped         int
}

// Collect with no database connection or global write gate. A bounded detached
// collector also lets shutdown finish if a hard-mounted NAS stalls in a kernel
// syscall, which context cancellation alone cannot interrupt. A stalled task
// retains the sole scan slot; following scans fail explicitly instead of
// spawning unbounded goroutines. It never writes files or touches the database.
func (a *App) collectDocumentDirectory(parent context.Context, source *DocumentSource) documentScan {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	select {
	case a.documentScanGate <- struct{}{}:
	default:
		return documentScan{status: "error", message: "A storage scan is still waiting for the filesystem. The previous index is retained."}
	}
	result := make(chan documentScan, 1)
	go func() { defer func() { <-a.documentScanGate }(); result <- a.readDocumentDirectory(ctx, source) }()
	select {
	case scan := <-result:
		return scan
	case <-ctx.Done():
		return documentScan{status: "error", message: "The directory scan timed out or was cancelled. The previous index is retained; check the storage connection."}
	}
}

func (a *App) readDocumentDirectory(ctx context.Context, source *DocumentSource) documentScan {
	scan := documentScan{seen: map[string]bool{}, status: "ready"}
	root, err := a.openDocumentRoot(source.Path)
	if err != nil {
		scan.status = "offline"
		scan.message = documentFileStatusMessage(err)
		return scan
	}
	defer root.Close()
	bytes, entries := 0, 0
	err = fs.WalkDir(root.FS(), ".", func(relative string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 50000 {
			return invalid("The directory exceeds the 50,000-entry scan limit; bind smaller subdirectories.")
		}
		if relative != "." && strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			if len(scan.directories) < 8192 {
				scan.directories = append(scan.directories, filepath.Join(source.Path, filepath.FromSlash(relative)))
			}
			return nil
		}
		if !isMarkdownPath(relative) {
			return nil
		}
		if _, err := cleanDocumentPath(relative, false); err != nil {
			scan.skipped++
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		scan.seen[relative] = true
		if !info.Mode().IsRegular() || info.Size() > maxDocumentBytes {
			scan.skipped++
			return nil
		}
		body, info, err := readDocumentFile(root, relative, maxDocumentBytes)
		if err != nil {
			return err
		}
		if err = validateDocumentContent(string(body)); err != nil {
			scan.skipped++
			return nil
		}
		bytes += len(body)
		if len(scan.found) >= maxSourceDocuments || bytes > maxSourceBytes {
			return invalid("The directory exceeds the document count or content scan budget; bind smaller subdirectories.")
		}
		scan.found = append(scan.found, scannedDocument{relative, body, info.ModTime().UTC().Format(time.RFC3339Nano)})
		return nil
	})
	if err != nil {
		scan.status = "error"
		scan.message = documentFileStatusMessage(err)
	}
	return scan
}

// Apply only a complete scan in a short SQL transaction. Missing files retain
// their IDs, metadata, publication and recovery history; they are never deleted.
func (a *App) applyDocumentScan(r *Request, s *DocumentSource, scan documentScan, confirmMissing bool) error {
	setStatus := func(status, message string) error {
		s.Status = status
		s.LastError = message
		s.LastScanAt = nowUTC()
		if status != "ready" {
			if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM documents WHERE source_id=? AND status='ready'"), s.ID).Scan(&s.DocumentCount); err != nil {
				return err
			}
		}
		_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE document_sources SET status=?,last_error=?,last_scan_at=? WHERE id=?"), s.Status, s.LastError, s.LastScanAt, s.ID)
		return err
	}
	if scan.status != "ready" {
		return setStatus(scan.status, scan.message)
	}
	activityStarted, err := a.documentActivityBaseline(r, s.ID)
	if err != nil {
		return err
	}
	old := map[string]struct{ id, revision, modified string }{}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,relative_path,revision,updated_at FROM documents WHERE source_id=? AND status='ready'"), s.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, rel, rev, modified string
		if err = rows.Scan(&id, &rel, &rev, &modified); err != nil {
			rows.Close()
			return err
		}
		old[rel] = struct{ id, revision, modified string }{id, rev, modified}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	newByHash := map[string][]int{}
	oldByHash := map[string][]string{}
	for i, file := range scan.found {
		if _, ok := old[file.relative]; !ok {
			hash := documentHash(file.body)
			newByHash[hash] = append(newByHash[hash], i)
		}
	}
	missingCount := 0
	for relative, doc := range old {
		if !scan.seen[relative] {
			missingCount++
			oldByHash[doc.revision] = append(oldByHash[doc.revision], relative)
		}
	}
	type rename struct{ from, to, id string }
	renames := []rename{}
	for hash, indices := range newByHash {
		previous := oldByHash[hash]
		if len(indices) != 1 || len(previous) != 1 {
			continue
		}
		var exists bool
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM documents WHERE source_id=? AND relative_path=?)"), s.ID, scan.found[indices[0]].relative).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		renames = append(renames, rename{previous[0], scan.found[indices[0]].relative, old[previous[0]].id})
		missingCount--
	}
	if !confirmMissing && (len(old) > 0 && len(scan.seen) == 0 || len(old) >= 10 && missingCount*2 > len(old)) {
		return setStatus("error", "The directory is unexpectedly empty or many files are missing. The previous index is retained. Check the mount, then explicitly confirm missing files if the removal was intentional.")
	}
	renamed := map[string]bool{}
	for _, rename := range renames {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE documents SET relative_path=? WHERE id=?"), rename.to, rename.id); err != nil {
			return err
		}
		if activityStarted != "" {
			revision := old[rename.from].revision
			if err = a.recordDocumentActivity(r, rename.id, "rename", "external", revision, revision); err != nil {
				return err
			}
		}
		renamed[rename.to] = true
		delete(old, rename.from)
	}
	for _, file := range scan.found {
		revision := documentHash(file.body)
		previous, existed := old[file.relative]
		if existed && previous.revision == revision && previous.modified == file.modified {
			continue
		}
		action, before := "", previous.revision
		if activityStarted != "" && !renamed[file.relative] {
			if existed && previous.revision != revision {
				action = "update"
			} else if !existed {
				// A missing file that reappears keeps its identity. Distinguish
				// restoration from a newly discovered file before upserting it.
				var oldStatus string
				err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision,status FROM documents WHERE source_id=? AND relative_path=?"), s.ID, file.relative).Scan(&before, &oldStatus)
				if errors.Is(err, sql.ErrNoRows) {
					action = "create"
				} else if err != nil {
					return err
				} else if oldStatus != "ready" {
					action = "restore"
				}
			}
		}
		if err = a.indexDocument(r, s, file.relative, file.body, file.modified); err != nil {
			return err
		}
		if action != "" {
			var id string
			if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM documents WHERE source_id=? AND relative_path=?"), s.ID, file.relative).Scan(&id); err != nil {
				return err
			}
			if err = a.recordDocumentActivity(r, id, action, "external", before, revision); err != nil {
				return err
			}
		}
	}
	for relative, doc := range old {
		if !scan.seen[relative] {
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE documents SET status='missing' WHERE id=?"), doc.id); err != nil {
				return err
			}
			if activityStarted != "" {
				if err = a.recordDocumentActivity(r, doc.id, "delete", "external", doc.revision, ""); err != nil {
					return err
				}
			}
		}
	}
	if activityStarted == "" {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE document_sources SET activity_started_at=? WHERE id=? AND activity_started_at=''"), documentActivityStamp(time.Now()), s.ID); err != nil {
			return err
		}
	}
	s.DocumentCount = len(scan.found)
	message := ""
	if scan.skipped > 0 {
		message = strconv.Itoa(scan.skipped) + " unsupported files were skipped without changing their originals."
	}
	return setStatus("ready", message)
}

func (a *App) indexDocument(r *Request, s *DocumentSource, relative string, body []byte, modified string) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO documents(id,source_id,space_id,relative_path,title,revision,size,updated_at,status,tags,search_text) VALUES(?,?,?,?,?,?,?,?,?,'[]',?) ON CONFLICT(source_id,relative_path) DO UPDATE SET title=excluded.title,revision=excluded.revision,size=excluded.size,updated_at=excluded.updated_at,status='ready',search_text=excluded.search_text WHERE documents.revision<>excluded.revision OR documents.title<>excluded.title OR documents.status<>'ready' OR documents.updated_at<>excluded.updated_at"), newID(), s.ID, s.SpaceID, relative, documentTitle(relative, body), documentHash(body), len(body), modified, "ready", string(body))
	return err
}

func (a *App) enabledDocumentSources(ctx context.Context) ([]*DocumentSource, error) {
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, err
	}
	rows, err := a.store.DB.QueryContext(ctx, a.store.Query("SELECT "+documentSourceColumns+" FROM document_sources WHERE enabled=?"), true)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*DocumentSource{}
	for rows.Next() {
		source, err := scanDocumentSource(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, source)
	}
	return items, rows.Err()
}

func (a *App) scanDocumentInBackground(ctx context.Context, source *DocumentSource) (documentScan, bool) {
	select {
	case a.documentGate <- struct{}{}:
		defer func() { <-a.documentGate }()
	case <-ctx.Done():
		return documentScan{}, false
	}
	scan := a.collectDocumentDirectory(ctx, source)
	r := &Request{App: a, HTTP: (&http.Request{}).WithContext(ctx)}
	_, err := a.documentTransaction(r, func(rr *Request) (*Response, error) {
		current, err := scanDocumentSource(rr.Q.QueryRowContext(ctx, a.store.Query("SELECT "+documentSourceColumns+" FROM document_sources WHERE id=?"), source.ID))
		if err != nil {
			return nil, err
		}
		if !current.Enabled || current.Revision != source.Revision {
			return nil, conflict("The directory configuration changed during the scan.")
		}
		if err = a.applyDocumentScan(rr, current, scan, false); err != nil {
			return nil, err
		}
		return nil, nil
	})
	return scan, err == nil
}

func (a *App) startDocumentWorker() {
	if len(a.config.DocumentRoots) == 0 {
		return
	}
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		watcher, _ := fsnotify.NewWatcher()
		if watcher != nil {
			defer watcher.Close()
		}
		var events <-chan fsnotify.Event
		var watchErrors <-chan error
		if watcher != nil {
			events = watcher.Events
			watchErrors = watcher.Errors
		}
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		dirty := map[string]bool{}
		watched := map[string]bool{}
		watchAttempted := map[string]bool{}
		overflow := false
		for {
			select {
			case <-a.ctx.Done():
				return
			case event, open := <-events:
				if !open {
					events = nil
					continue
				}
				if !strings.HasPrefix(filepath.Base(event.Name), ".lingshu-") {
					if event.Op.Has(fsnotify.Remove) || event.Op.Has(fsnotify.Rename) {
						delete(watched, event.Name)
					}
					if len(dirty) < 4096 {
						dirty[event.Name] = true
					} else {
						overflow = true
					}
				}
				continue
			case _, open := <-watchErrors:
				if !open {
					watchErrors = nil
				}
				overflow = true
				continue
			case <-ticker.C:
			}
			sources, err := a.enabledDocumentSources(a.ctx)
			if err != nil {
				continue
			}
			for _, source := range sources {
				changed := overflow
				for name := range dirty {
					if insideDocumentPath(source.Path, name) {
						changed = true
						break
					}
				}
				last, _ := time.Parse(time.RFC3339Nano, source.LastScanAt)
				needsWatch := watcher != nil && !watchAttempted[source.ID] && source.Status == "ready"
				if !changed && time.Since(last) < time.Duration(source.ScanIntervalSeconds)*time.Second && !needsWatch {
					continue
				}
				ctx, cancel := context.WithTimeout(a.ctx, 35*time.Second)
				scan, applied := a.scanDocumentInBackground(ctx, source)
				cancel()
				watchAttempted[source.ID] = true
				if !applied || scan.status != "ready" || watcher == nil {
					continue
				}
				currentDirectories := map[string]bool{}
				for _, directory := range scan.directories {
					currentDirectories[directory] = true
				}
				for directory := range watched {
					if insideDocumentPath(source.Path, directory) && !currentDirectories[directory] {
						_ = watcher.Remove(directory)
						delete(watched, directory)
					}
				}
				for _, directory := range scan.directories {
					if len(watched) >= 8192 {
						break
					}
					if !watched[directory] && watcher.Add(directory) == nil {
						watched[directory] = true
					}
				}
			}
			dirty = map[string]bool{}
			overflow = false
			for directory := range watched {
				active := false
				for _, source := range sources {
					if insideDocumentPath(source.Path, directory) {
						active = true
						break
					}
				}
				if !active {
					_ = watcher.Remove(directory)
					delete(watched, directory)
				}
			}
		}
	}()
}
