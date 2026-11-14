package home

import (
	"bytes"
	"encoding/json"
	"strings"
)

// This is the business work-session context. It is unrelated to a transport's
// session identifier and never substitutes for the authenticated principal.
type WorkMutationContext struct {
	SessionID       string `json:"sessionId"`
	ClaimID         string `json:"claimId,omitempty"`
	ClaimGeneration string `json:"claimGeneration,omitempty"`
	OperationID     string `json:"operationId"`
}

func decodeWorkMutationContext(raw json.RawMessage) (*WorkMutationContext, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, invalid("context cannot be null.")
	}
	var value WorkMutationContext
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&value); err != nil {
		return nil, invalid("Invalid work context. Use sessionId, claimId, claimGeneration and operationId only.")
	}
	return &value, nil
}
func (a *App) prepareWorkMutationContext(r *Request, space string, c *WorkMutationContext) (*WorkSession, error) {
	if c == nil {
		return nil, nil
	}
	if err := r.requireAction("work:read"); err != nil {
		return nil, err
	}
	if err := workOperationValid(c.OperationID); err != nil {
		return nil, err
	}
	return a.loadWorkSession(r, space, c.SessionID, true)
}
func (a *App) guardWorkMutation(r *Request, item *WorkItem, c *WorkMutationContext, session *WorkSession) error {
	claim, err := a.loadWorkClaim(r, item.SpaceID, item.ID)
	if err != nil {
		return err
	}
	if c != nil {
		if err = requireOpenWorkSession(session); err != nil {
			return err
		}
	}
	if claim.pending() {
		// A narrow write-only bearer must not learn claim attribution via conflicts.
		if err = r.requireAction("work:read"); err != nil {
			return err
		}
		if c == nil {
			if r.Bearer {
				return workClaimError("work_claim_required", "This item has a pending claim. Read its owner and handoff; writes require the current business session and claim generation.", claim)
			}
			return workClaimError("work_claim_conflict", "An Agent owns or left unresolved work on this item. Verify external work has stopped, then explicitly resolve the claim before editing.", claim)
		}
		return validateWorkClaimOwner(claim, workClaimOwnerInput{SessionID: c.SessionID, ClaimID: c.ClaimID, ClaimGeneration: c.ClaimGeneration, OperationID: c.OperationID})
	}
	if c != nil {
		return validateWorkClaimOwner(claim, workClaimOwnerInput{SessionID: c.SessionID, ClaimID: c.ClaimID, ClaimGeneration: c.ClaimGeneration, OperationID: c.OperationID})
	}
	if r.Bearer && a.config.MCPCollaborationEnabled {
		return workCollabError("work_claim_required", "Collaboration is enabled. Register a work session, read the current item and acquire a claim before editing, moving or archiving.")
	}
	return nil
}
func (a *App) updateWorkItem(r *Request) (*Response, error) {
	return a.coordinatedWorkMutation(r, "item.update", a.updateWorkItemValue)
}
func (a *App) moveWorkItem(r *Request) (*Response, error) {
	return a.coordinatedWorkMutation(r, "item.move", a.moveWorkItemValue)
}
func (a *App) coordinatedWorkMutation(r *Request, action string, handler handlerFunc) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	c, err := decodeWorkMutationContext(raw["context"])
	if err != nil {
		return nil, err
	}
	session, err := a.prepareWorkMutationContext(r, s.ID, c)
	if err != nil {
		return nil, err
	}
	hash := ""
	if c != nil {
		hash = workOperationHash(action, item.ID, raw)
		if resp, e := a.workOperationReplay(r, s.ID, c.OperationID, hash); e != nil || resp != nil {
			return resp, e
		}
	}
	if err = a.guardWorkMutation(r, item, c, session); err != nil {
		return nil, err
	}
	delete(raw, "context")
	r.Input = []byte(jsonString(raw))
	if session != nil {
		setWorkRequestSession(r, session)
	}
	response, err := handler(r)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return response, nil
	}
	current, err := a.loadWorkItem(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	status, err := a.requireWorkStatus(r, s.ID, current.Status)
	if err != nil {
		return nil, err
	}
	// Business revision and terminal release share the same transaction. A late
	// worker cannot keep writing merely by obtaining this new business revision.
	kind := ""
	if current.Archived {
		kind = "item_archived"
	} else if status.Type == "done" {
		kind = "item_completed"
	} else if status.Type == "canceled" {
		kind = "item_canceled"
	}
	if kind != "" {
		stamp := workStamp()
		result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET released_at=?,unresolved=?,last_seen_at=? WHERE item_id=? AND space_id=? AND claim_id=? AND session_id=? AND generation=? AND released_at=''"), stamp, false, stamp, current.ID, s.ID, c.ClaimID, c.SessionID, c.ClaimGeneration)
		if err = workClaimCAS(result, err); err != nil {
			return nil, err
		}
		if _, err = a.insertWorkEvent(r, s.ID, current.ID, c.OperationID, kind, "", session, nil); err != nil {
			return nil, err
		}
	}
	if err = a.touchWorkSession(r, session.ID, workStamp()); err != nil {
		return nil, err
	}
	response, err = a.workItemReply(r, current, nil)
	if err != nil {
		return nil, err
	}
	revision, err := a.workRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	// Receipts deliberately contain no referenced document/link bodies or names.
	// A credential may lose those read scopes between the write and its retry.
	receipt := map[string]any{"id": current.ID, "revision": current.Revision, "boardRevision": revision, "replayed": true}
	if err = a.saveWorkOperation(r, s.ID, c.OperationID, hash, receipt); err != nil {
		return nil, err
	}
	return response, nil
}
func (a *App) prepareWorkCreation(r *Request, space, item string, input workCreateInput, c *WorkMutationContext) (*Response, string, error) {
	if c == nil {
		if r.Bearer && a.config.MCPCollaborationEnabled {
			return nil, "", workCollabError("work_session_required", "Collaboration is enabled. Register a work session and supply context.sessionId and context.operationId for new work.")
		}
		return nil, "", nil
	}
	if c.ClaimID != "" || c.ClaimGeneration != "" {
		return nil, "", invalid("New work accepts sessionId and operationId only; acquire a claim after creation.")
	}
	session, err := a.prepareWorkMutationContext(r, space, c)
	if err != nil {
		return nil, "", err
	}
	hash := workOperationHash("item.create", item, struct {
		Input   workCreateInput
		Context *WorkMutationContext
	}{input, c})
	if resp, e := a.workOperationReplay(r, space, c.OperationID, hash); e != nil || resp != nil {
		return resp, hash, e
	}
	if err = requireOpenWorkSession(session); err != nil {
		return nil, "", err
	}
	if err = a.requireCollaborationEnabled(); err != nil {
		return nil, "", err
	}
	setWorkRequestSession(r, session)
	return nil, hash, nil
}
func (a *App) finishWorkCreation(r *Request, item *WorkItem, c *WorkMutationContext, hash string) error {
	if c == nil {
		return nil
	}
	if err := a.touchWorkSession(r, c.SessionID, workStamp()); err != nil {
		return err
	}
	revision, err := a.workRevision(r, item.SpaceID)
	if err != nil {
		return err
	}
	return a.saveWorkOperation(r, item.SpaceID, c.OperationID, hash, map[string]any{"id": item.ID, "revision": item.Revision, "boardRevision": revision, "replayed": true})
}

// Status semantics and migration are shared-space administrative operations,
// not an implicit claim takeover. Block only changes that affect pending items.
func (a *App) guardWorkStatusCollaboration(r *Request, space string, statuses []string) error {
	if len(statuses) == 0 {
		return nil
	}
	args := []any{space, true}
	holders := make([]string, len(statuses))
	for i, id := range statuses {
		holders[i] = "?"
		args = append(args, id)
	}
	query := "SELECT COUNT(*) FROM work_claims c JOIN work_items w ON w.id=c.item_id AND w.space_id=c.space_id WHERE c.space_id=? AND (c.released_at='' OR c.unresolved=?) AND w.status IN (" + strings.Join(holders, ",") + ")"
	var count int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query(query), args...).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return workCollabError("work_claim_conflict", "Status type changes or migrations affect pending claimed work. Coordinate with its owners or explicitly resolve the claims before changing status semantics.")
	}
	return nil
}
