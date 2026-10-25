package home

// documentTransaction performs the short database phase after filesystem I/O.
// The calling HTTP/MCP request already captured its authorization snapshot and
// holds documentGate for mutations; source bindings therefore cannot change
// underneath it. Account/session revocation applies to following requests, as
// with other already-dispatched handlers. Filesystem work MUST stay outside fn.
func (a *App) documentTransaction(original *Request, fn handlerFunc) (*Response, error) {
	ctx := original.HTTP.Context()
	select {
	case a.writeGate <- struct{}{}:
		defer func() { <-a.writeGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, err
	}
	tx, err := a.store.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	r := *original
	r.Q = tx
	response, err := fn(&r)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return response, nil
}

func documentOperationError(r *Request, err error) error {
	if !r.DocumentFileChanged {
		return err
	}
	return &APIError{Status: 503, Code: "document_index_pending", Message: "The original file may already have changed, but the operation or its metadata/response could not be finalized. Inspect the original and rescan before retrying; any recovery copies have been retained."}
}
