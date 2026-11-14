package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const workDefaultLease = 1800
const workMinLease = 300
const workMaxLease = 7200

type WorkSession struct {
	ID               string             `json:"id"`
	SpaceID          string             `json:"spaceId"`
	Actor            *WorkActivityActor `json:"actor"`
	AgentName        string             `json:"agentName"`
	ClientName       string             `json:"clientName"`
	Role             string             `json:"role"`
	ParentSessionID  string             `json:"parentSessionId,omitempty"`
	ResumesSessionID string             `json:"resumesSessionId,omitempty"`
	CreatedAt        string             `json:"createdAt"`
	LastSeenAt       string             `json:"lastSeenAt"`
	ClosedAt         string             `json:"closedAt,omitempty"`
}
type WorkSessionAttribution struct {
	ID         string `json:"id"`
	AgentName  string `json:"agentName"`
	ClientName string `json:"clientName"`
	Role       string `json:"role"`
}
type WorkHandoff struct {
	Completed string `json:"completed"`
	Workspace string `json:"workspace"`
	NextStep  string `json:"nextStep"`
	Unknowns  string `json:"unknowns"`
}
type WorkCollaboration struct {
	Enabled        bool         `json:"enabled"`
	State          string       `json:"state"`
	ClaimID        string       `json:"claimId,omitempty"`
	Generation     string       `json:"generation"`
	Session        *WorkSession `json:"session,omitempty"`
	ExpiresAt      string       `json:"expiresAt,omitempty"`
	LastSeenAt     string       `json:"lastSeenAt,omitempty"`
	LastProgressAt string       `json:"lastProgressAt,omitempty"`
	LatestHandoff  *WorkHandoff `json:"latestHandoff,omitempty"`
	Unresolved     bool         `json:"unresolved"`
	CanResolve     bool         `json:"canResolve"`
	ServerTime     string       `json:"serverTime"`
	ItemID         string       `json:"itemId,omitempty"`
}
type workClaim struct {
	ItemID, SpaceID, ClaimID, SessionID               string
	Generation                                        int64
	ExpiresAt, LastSeenAt, LastProgressAt, ReleasedAt string
	Unresolved                                        bool
	Handoff                                           *WorkHandoff
}

func (c *workClaim) pending() bool { return c != nil && (c.ReleasedAt == "" || c.Unresolved) }
func (c *workClaim) live() bool {
	if c == nil || c.ReleasedAt != "" {
		return false
	}
	expires, err := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	return err == nil && time.Now().Before(expires)
}
func workCollabError(code, message string) error {
	return &APIError{Status: http.StatusConflict, Code: code, Message: message}
}
func workClaimError(code, message string, c *workClaim) error {
	e := &APIError{Status: http.StatusConflict, Code: code, Message: message}
	if c != nil {
		e.Details = map[string]any{"itemId": c.ItemID, "currentGeneration": strconv.FormatInt(c.Generation, 10)}
	}
	return e
}
func (a *App) registerWorkCollaborationRoutes(base string) {
	a.route("GET "+base+"/collaboration", false, a.getWorkCollaborationContext)
	a.route("POST "+base+"/sessions", true, a.openWorkSession)
	a.route("GET "+base+"/sessions/{id}", false, a.getWorkSession)
	a.route("POST "+base+"/sessions/{id}/close", true, a.closeWorkSession)
	a.route("POST "+base+"/items/{id}/claim", true, a.acquireWorkClaim)
	a.route("POST "+base+"/items/{id}/claim/renew", true, a.renewWorkClaim)
	a.route("POST "+base+"/items/{id}/claim/release", true, a.releaseWorkClaim)
	a.route("POST "+base+"/items/{id}/claim/resolve", true, a.resolveWorkClaim)
	a.route("GET "+base+"/items/{id}/events", false, a.listWorkEvents)
	a.route("POST "+base+"/items/{id}/events", true, a.appendWorkEvent)
}
func (r *Request) workCollaborationSpace(write bool) (*Space, error) {
	s, err := r.workSpace(write)
	if err != nil {
		return nil, err
	}
	if write {
		if err = r.requireAction("work:read"); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (a *App) getWorkCollaborationContext(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(false)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"enabled": a.config.MCPCollaborationEnabled, "effectiveEnabled": a.config.MCPCollaborationEnabled && s.CanEdit, "version": "1", "serverTime": workStamp(), "defaultLeaseSeconds": workDefaultLease, "minLeaseSeconds": workMinLease, "maxLeaseSeconds": workMaxLease}), nil
}
func (a *App) requireCollaborationEnabled() error {
	if !a.config.MCPCollaborationEnabled {
		return workCollabError("work_collaboration_disabled", "New sessions and claims are disabled. Existing claims remain protected; renew, release, close and human recovery are still available.")
	}
	return nil
}
func workSessionSnapshot(s *WorkSession) *WorkSessionAttribution {
	if s == nil {
		return nil
	}
	return &WorkSessionAttribution{ID: s.ID, AgentName: s.AgentName, ClientName: s.ClientName, Role: s.Role}
}

type workSessionContextKey struct{}

func workRequestSession(r *Request) *WorkSession {
	s, _ := r.HTTP.Context().Value(workSessionContextKey{}).(*WorkSession)
	return s
}
func setWorkRequestSession(r *Request, s *WorkSession) {
	r.HTTP = r.HTTP.WithContext(context.WithValue(r.HTTP.Context(), workSessionContextKey{}, s))
}
func (a *App) loadWorkSession(r *Request, space, id string, own bool) (*WorkSession, error) {
	if !validID(id) {
		return nil, missing()
	}
	s := &WorkSession{Actor: &WorkActivityActor{}}
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT s.id,s.space_id,s.user_id,COALESCE(NULLIF(u.display_name,''),u.username),s.agent_name,s.client_name,s.role,s.parent_session_id,s.resumes_session_id,s.created_at,s.last_seen_at,s.closed_at FROM work_sessions s JOIN users u ON u.id=s.user_id WHERE s.space_id=? AND s.id=?"), space, id).Scan(&s.ID, &s.SpaceID, &s.Actor.ID, &s.Actor.Name, &s.AgentName, &s.ClientName, &s.Role, &s.ParentSessionID, &s.ResumesSessionID, &s.CreatedAt, &s.LastSeenAt, &s.ClosedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if own && (r.User == nil || s.Actor.ID != r.User.ID) {
		return nil, missing()
	}
	return s, nil
}
func requireOpenWorkSession(s *WorkSession) error {
	if s.ClosedAt != "" {
		return workCollabError("work_session_closed", "This work session is closed. Register a new session with resumesSessionId; do not reuse a closed session.")
	}
	return nil
}
func (a *App) touchWorkSession(r *Request, id, stamp string) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_sessions SET last_seen_at=? WHERE id=? AND closed_at=''"), stamp, id)
	return err
}
func (a *App) openWorkSession(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		RegistrationID   string `json:"registrationId"`
		AgentName        string `json:"agentName"`
		ClientName       string `json:"clientName"`
		Role             string `json:"role"`
		ParentSessionID  string `json:"parentSessionId"`
		ResumesSessionID string `json:"resumesSessionId"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.RegistrationID) {
		return nil, invalid("registrationId must be 32 lowercase hexadecimal characters and retained for retries.")
	}
	if in.AgentName, err = required(in.AgentName, "agentName", 80); err != nil {
		return nil, err
	}
	for _, v := range []struct{ value, name string }{{in.ClientName, "clientName"}, {in.Role, "role"}} {
		if err = bounded(v.value, v.name, 80); err != nil {
			return nil, err
		}
	}
	hash := workPayloadHash(in)
	var id, oldHash string
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,create_hash FROM work_sessions WHERE space_id=? AND user_id=? AND registration_id=?"), s.ID, r.User.ID, in.RegistrationID).Scan(&id, &oldHash)
	if err == nil {
		if hash != oldHash {
			return nil, workCollabError("work_operation_conflict", "registrationId was already used with a different payload. Read the original session; do not change the retry payload.")
		}
		existing, e := a.loadWorkSession(r, s.ID, id, true)
		if e != nil {
			return nil, e
		}
		return ok(existing), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err = a.requireCollaborationEnabled(); err != nil {
		return nil, err
	}
	for _, related := range []string{in.ParentSessionID, in.ResumesSessionID} {
		if related != "" {
			if _, err = a.loadWorkSession(r, s.ID, related, true); err != nil {
				return nil, err
			}
		}
	}
	id = newID()
	stamp := workStamp()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_sessions(id,space_id,user_id,registration_id,create_hash,agent_name,client_name,role,parent_session_id,resumes_session_id,created_at,last_seen_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'')"), id, s.ID, r.User.ID, in.RegistrationID, hash, in.AgentName, in.ClientName, in.Role, in.ParentSessionID, in.ResumesSessionID, stamp, stamp)
	if err != nil {
		return nil, err
	}
	result, err := a.loadWorkSession(r, s.ID, id, true)
	if err != nil {
		return nil, err
	}
	return ok(result), nil
}
func (a *App) getWorkSession(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(false)
	if err != nil {
		return nil, err
	}
	session, err := a.loadWorkSession(r, s.ID, r.param("id"), true)
	if err != nil {
		return nil, err
	}
	return ok(session), nil
}
func workOperationValid(id string) error {
	if !validID(id) {
		return invalid("operationId must be 32 lowercase hexadecimal characters and retained with the original payload for retries.")
	}
	return nil
}
func (a *App) workOperationReplay(r *Request, space, id, hash string) (*Response, error) {
	if err := workOperationValid(id); err != nil {
		return nil, err
	}
	var oldHash, body string
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT request_hash,response_json FROM work_operation_receipts WHERE space_id=? AND user_id=? AND operation_id=?"), space, r.User.ID, id).Scan(&oldHash, &body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hash != oldHash {
		return nil, workCollabError("work_operation_conflict", "operationId belongs to a different request. Keep the original operation ID and payload after an uncertain response; use a new ID only for new work.")
	}
	var data any
	if err = json.Unmarshal([]byte(body), &data); err != nil {
		return nil, err
	}
	return ok(data), nil
}
func (a *App) saveWorkOperation(r *Request, space, id, hash string, data any) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_operation_receipts(space_id,user_id,operation_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?)"), space, r.User.ID, id, hash, jsonString(data), workStamp())
	return err
}
func workOperationHash(action, target string, payload any) string {
	var normalized any
	decoder := json.NewDecoder(strings.NewReader(jsonString(payload)))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		return workPayloadHash(payload)
	}
	return workPayloadHash(struct {
		Action, Target string
		Payload        any
	}{action, target, normalized})
}
func (a *App) closeWorkSession(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	session, err := a.loadWorkSession(r, s.ID, r.param("id"), true)
	if err != nil {
		return nil, err
	}
	var in struct {
		OperationID string `json:"operationId"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	hash := workOperationHash("session.close", session.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT item_id FROM work_claims WHERE space_id=? AND session_id=? AND (released_at='' OR unresolved=?) ORDER BY item_id"), s.ID, session.ID, true)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		return nil, &APIError{Status: 409, Code: "work_session_has_claims", Message: "Resolve or hand off every active, expired or unresolved claim before closing this session.", Details: map[string]any{"itemIds": ids}}
	}
	if session.ClosedAt == "" {
		session.ClosedAt = workStamp()
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_sessions SET closed_at=?,last_seen_at=? WHERE id=? AND closed_at=''"), session.ClosedAt, session.ClosedAt, session.ID)
		if err != nil {
			return nil, err
		}
		session.LastSeenAt = session.ClosedAt
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, session); err != nil {
		return nil, err
	}
	return ok(session), nil
}
func (a *App) loadWorkClaim(r *Request, space, item string) (*workClaim, error) {
	c := &workClaim{}
	var handoff string
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT item_id,space_id,claim_id,session_id,generation,expires_at,last_seen_at,last_progress_at,released_at,unresolved,handoff_json FROM work_claims WHERE space_id=? AND item_id=?"), space, item).Scan(&c.ItemID, &c.SpaceID, &c.ClaimID, &c.SessionID, &c.Generation, &c.ExpiresAt, &c.LastSeenAt, &c.LastProgressAt, &c.ReleasedAt, &c.Unresolved, &handoff)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if handoff != "" {
		if err = json.Unmarshal([]byte(handoff), &c.Handoff); err != nil {
			return nil, err
		}
	}
	return c, nil
}
func (a *App) workCollaborationSummary(r *Request, space, item string) (*WorkCollaboration, error) {
	c, err := a.loadWorkClaim(r, space, item)
	if err != nil {
		return nil, err
	}
	return a.workCollaborationFromClaim(r, c)
}
func (a *App) workCollaborationFromClaim(r *Request, c *workClaim) (*WorkCollaboration, error) {
	var session *WorkSession
	if c != nil {
		var err error
		session, err = a.loadWorkSession(r, c.SpaceID, c.SessionID, false)
		if err != nil {
			return nil, err
		}
	}
	return a.workCollaborationView(r, c, session), nil
}

// Pure projection shared by the detail and batched board/list queries.
func (a *App) workCollaborationView(r *Request, c *workClaim, session *WorkSession) *WorkCollaboration {
	if c == nil && !a.config.MCPCollaborationEnabled {
		return nil
	}
	out := &WorkCollaboration{Enabled: a.config.MCPCollaborationEnabled, State: "unclaimed", Generation: "0", ServerTime: workStamp()}
	if c == nil {
		return out
	}
	out.ItemID = c.ItemID
	out.ClaimID = c.ClaimID
	out.Generation = strconv.FormatInt(c.Generation, 10)
	out.ExpiresAt = c.ExpiresAt
	out.LastSeenAt = c.LastSeenAt
	out.LastProgressAt = c.LastProgressAt
	out.LatestHandoff = c.Handoff
	out.Unresolved = c.Unresolved
	out.CanResolve = !r.Bearer && c.pending()
	out.Session = session
	out.State = "released"
	if c.ReleasedAt == "" {
		out.State = "expired"
		if c.live() {
			out.State = "active"
		}
	}
	return out
}
func (a *App) workCollaborationRevision(r *Request, space string) (string, error) {
	var n int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision FROM work_collaboration_spaces WHERE space_id=?"), space).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return "0", nil
	}
	return strconv.FormatInt(n, 10), err
}
func (a *App) nextWorkCollaborationSequence(r *Request, space string) (int64, error) {
	var n int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_collaboration_spaces(space_id,revision) VALUES(?,1) ON CONFLICT(space_id) DO UPDATE SET revision=work_collaboration_spaces.revision+1 RETURNING revision"), space).Scan(&n)
	return n, err
}

type workLeaseValue int

func (value *workLeaseValue) UnmarshalJSON(data []byte) error {
	var seconds int
	if err := json.Unmarshal(data, &seconds); err != nil {
		return invalid("leaseSeconds must be an integer from 300 to 7200.")
	}
	if seconds < workMinLease || seconds > workMaxLease {
		return invalid("leaseSeconds must be an integer from 300 to 7200.")
	}
	*value = workLeaseValue(seconds)
	return nil
}
func workLease(seconds int) (int, error) {
	if seconds == 0 {
		return workDefaultLease, nil
	}
	if seconds < workMinLease || seconds > workMaxLease {
		return 0, invalid("leaseSeconds must be an integer from 300 to 7200.")
	}
	return seconds, nil
}
func workGeneration(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != value {
		return 0, invalid("A canonical nonnegative claim generation string is required.")
	}
	return n, nil
}
func workClaimCAS(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return workCollabError("work_claim_generation_conflict", "The claim changed. Re-read its current owner and generation; never reuse a stale claim.")
	}
	return nil
}

type workRecovery struct {
	Reason                    string `json:"reason"`
	ExternalOperationsStopped bool   `json:"externalOperationsStopped"`
}

func validateWorkRecovery(recovery *workRecovery) error {
	if recovery == nil || !recovery.ExternalOperationsStopped || strings.TrimSpace(recovery.Reason) == "" {
		return workCollabError("work_recovery_required", "Explicitly verify external operations have stopped and record the verified result before recovery. Expiry does not prove external work is stopped.")
	}
	return bounded(recovery.Reason, "reason", 2000)
}
func (a *App) acquireWorkClaim(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		SessionID          string         `json:"sessionId"`
		OperationID        string         `json:"operationId"`
		ExpectedRevision   string         `json:"expectedRevision"`
		ExpectedGeneration string         `json:"expectedGeneration"`
		LeaseSeconds       workLeaseValue `json:"leaseSeconds"`
		Recovery           *workRecovery  `json:"recovery"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	session, err := a.loadWorkSession(r, s.ID, in.SessionID, true)
	if err != nil {
		return nil, err
	}
	hash := workOperationHash("claim.acquire", item.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	if err = a.requireCollaborationEnabled(); err != nil {
		return nil, err
	}
	if err = requireOpenWorkSession(session); err != nil {
		return nil, err
	}
	lease, err := workLease(int(in.LeaseSeconds))
	if err != nil {
		return nil, err
	}
	expected, err := workGeneration(in.ExpectedGeneration)
	if err != nil {
		return nil, err
	}
	if in.ExpectedRevision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if in.ExpectedRevision != item.Revision {
		return nil, workConflict("work_item_version_conflict", "The item changed. Read and compare the current item before claiming it.", item.Revision)
	}
	status, err := a.requireWorkStatus(r, s.ID, item.Status)
	if err != nil {
		return nil, err
	}
	if item.Archived || status.Type == "done" || status.Type == "canceled" {
		return nil, workCollabError("work_item_terminal", "Completed, canceled or archived work cannot be claimed. Create a separate task for a new release; correction needs explicit user intent.")
	}
	c, err := a.loadWorkClaim(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	generation := int64(0)
	if c != nil {
		generation = c.Generation
	}
	if generation != expected {
		return nil, workClaimError("work_claim_generation_conflict", "The claim generation changed. Re-read before deciding whether recovery is appropriate.", c)
	}
	kind := "claim_acquired"
	body := ""
	if c != nil && c.live() {
		return nil, workClaimError("work_claim_conflict", "Another live claim owns this item. Coordinate through events; do not take over active work.", c)
	}
	if c.pending() {
		if err = validateWorkRecovery(in.Recovery); err != nil {
			return nil, err
		}
		kind = "claim_recovered"
		body = in.Recovery.Reason
	} else if in.Recovery != nil {
		if err = validateWorkRecovery(in.Recovery); err != nil {
			return nil, err
		}
	}
	stamp := workStamp()
	expires := time.Now().UTC().Add(time.Duration(lease) * time.Second).Format(time.RFC3339Nano)
	claimID := newID()
	if c == nil {
		err = workClaimCAS(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_claims(item_id,space_id,claim_id,session_id,generation,expires_at,last_seen_at,last_progress_at,released_at,unresolved,handoff_json) VALUES(?,?,?,?,1,?,?,'','',?,'') ON CONFLICT(item_id) DO NOTHING"), item.ID, s.ID, claimID, session.ID, expires, stamp, false))
	} else {
		err = workClaimCAS(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET claim_id=?,session_id=?,generation=generation+1,expires_at=?,last_seen_at=?,last_progress_at='',released_at='',unresolved=? WHERE space_id=? AND item_id=? AND generation=?"), claimID, session.ID, expires, stamp, false, s.ID, item.ID, generation))
	}
	if err != nil {
		return nil, err
	}
	if err = a.touchWorkSession(r, session.ID, stamp); err != nil {
		return nil, err
	}
	if _, err = a.insertWorkEvent(r, s.ID, item.ID, in.OperationID, kind, body, session, nil); err != nil {
		return nil, err
	}
	out, err := a.workCollaborationSummary(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, out); err != nil {
		return nil, err
	}
	return ok(out), nil
}

type workClaimOwnerInput struct {
	SessionID       string `json:"sessionId"`
	ClaimID         string `json:"claimId"`
	ClaimGeneration string `json:"claimGeneration"`
	OperationID     string `json:"operationId"`
}

func validateWorkClaimOwner(c *workClaim, in workClaimOwnerInput) error {
	generation, err := workGeneration(in.ClaimGeneration)
	if err != nil {
		return err
	}
	if !validID(in.ClaimID) {
		return invalid("claimId must be a current server-issued claim ID.")
	}
	if c == nil || c.Generation != generation || c.ClaimID != in.ClaimID || c.SessionID != in.SessionID {
		return workClaimError("work_claim_generation_conflict", "The claim owner or generation changed. A stale worker cannot write using a newer item revision.", c)
	}
	if c.ReleasedAt != "" {
		return workClaimError("work_claim_conflict", "This claim has been released. Read its handoff before acquiring new work.", c)
	}
	if !c.live() {
		return workClaimError("work_claim_expired", "This claim expired. Verify external operation results and explicitly recover; renewal cannot revive an expired claim.", c)
	}
	return nil
}
func (a *App) renewWorkClaim(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		workClaimOwnerInput
		LeaseSeconds workLeaseValue `json:"leaseSeconds"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	session, err := a.loadWorkSession(r, s.ID, in.SessionID, true)
	if err != nil {
		return nil, err
	}
	hash := workOperationHash("claim.renew", item.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	if err = requireOpenWorkSession(session); err != nil {
		return nil, err
	}
	lease, err := workLease(int(in.LeaseSeconds))
	if err != nil {
		return nil, err
	}
	c, err := a.loadWorkClaim(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = validateWorkClaimOwner(c, in.workClaimOwnerInput); err != nil {
		return nil, err
	}
	stamp := workStamp()
	expires := time.Now().UTC().Add(time.Duration(lease) * time.Second).Format(time.RFC3339Nano)
	err = workClaimCAS(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET expires_at=?,last_seen_at=? WHERE item_id=? AND space_id=? AND generation=? AND claim_id=? AND session_id=? AND released_at='' AND expires_at=?"), expires, stamp, item.ID, s.ID, c.Generation, c.ClaimID, c.SessionID, c.ExpiresAt))
	if err != nil {
		return nil, err
	}
	if err = a.touchWorkSession(r, session.ID, stamp); err != nil {
		return nil, err
	}
	out, err := a.workCollaborationSummary(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, out); err != nil {
		return nil, err
	}
	return ok(out), nil
}
func validateWorkHandoff(h *WorkHandoff) error {
	if h == nil || strings.TrimSpace(h.NextStep) == "" {
		return invalid("A structured handoff with nextStep is required.")
	}
	for _, v := range []struct{ value, name string }{{h.Completed, "completed"}, {h.Workspace, "workspace"}, {h.NextStep, "nextStep"}, {h.Unknowns, "unknowns"}} {
		if err := bounded(v.value, v.name, 2000); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) releaseWorkClaim(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		workClaimOwnerInput
		Handoff *WorkHandoff `json:"handoff"`
		Reason  string       `json:"reason"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	session, err := a.loadWorkSession(r, s.ID, in.SessionID, true)
	if err != nil {
		return nil, err
	}
	hash := workOperationHash("claim.release", item.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	if err = requireOpenWorkSession(session); err != nil {
		return nil, err
	}
	if err = validateWorkHandoff(in.Handoff); err != nil {
		return nil, err
	}
	if in.Reason != "" && in.Reason != "handoff" && in.Reason != "pause" {
		return nil, invalid("reason must be handoff or pause.")
	}
	c, err := a.loadWorkClaim(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = validateWorkClaimOwner(c, in.workClaimOwnerInput); err != nil {
		return nil, err
	}
	stamp := workStamp()
	err = workClaimCAS(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET released_at=?,last_seen_at=?,unresolved=?,handoff_json=? WHERE item_id=? AND space_id=? AND generation=? AND claim_id=? AND session_id=? AND released_at=''"), stamp, stamp, strings.TrimSpace(in.Handoff.Unknowns) != "", jsonString(in.Handoff), item.ID, s.ID, c.Generation, c.ClaimID, c.SessionID))
	if err != nil {
		return nil, err
	}
	if err = a.touchWorkSession(r, session.ID, stamp); err != nil {
		return nil, err
	}
	if _, err = a.insertWorkEvent(r, s.ID, item.ID, in.OperationID, "claim_released", in.Reason, session, in.Handoff); err != nil {
		return nil, err
	}
	out, err := a.workCollaborationSummary(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, out); err != nil {
		return nil, err
	}
	return ok(out), nil
}
func (a *App) resolveWorkClaim(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	if r.Bearer {
		return nil, forbidden()
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		OperationID               string `json:"operationId"`
		ExpectedGeneration        string `json:"expectedGeneration"`
		Reason                    string `json:"reason"`
		ExternalOperationsStopped bool   `json:"externalOperationsStopped"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	hash := workOperationHash("claim.resolve", item.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	if err = validateWorkRecovery(&workRecovery{in.Reason, in.ExternalOperationsStopped}); err != nil {
		return nil, err
	}
	generation, err := workGeneration(in.ExpectedGeneration)
	if err != nil {
		return nil, err
	}
	c, err := a.loadWorkClaim(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if c == nil || c.Generation != generation {
		return nil, workClaimError("work_claim_generation_conflict", "The claim changed. Read it again before recovery.", c)
	}
	if !c.pending() {
		return nil, workClaimError("work_claim_conflict", "This claim is already resolved.", c)
	}
	stamp := workStamp()
	err = workClaimCAS(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET released_at=?,unresolved=?,generation=generation+1 WHERE item_id=? AND space_id=? AND generation=?"), stamp, false, item.ID, s.ID, generation))
	if err != nil {
		return nil, err
	}
	if _, err = a.insertWorkEvent(r, s.ID, item.ID, in.OperationID, "claim_resolved", in.Reason, nil, nil); err != nil {
		return nil, err
	}
	out, err := a.workCollaborationSummary(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, out); err != nil {
		return nil, err
	}
	return ok(out), nil
}

func (a *App) decorateWorkCollaboration(r *Request, space string, items []WorkSummary) error {
	if len(items) == 0 {
		return nil
	}
	args := []any{space}
	holders := make([]string, len(items))
	for i := range items {
		holders[i] = "?"
		args = append(args, items[i].ID)
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT c.item_id,c.space_id,c.claim_id,c.session_id,c.generation,c.expires_at,c.last_seen_at,c.last_progress_at,c.released_at,c.unresolved,c.handoff_json,s.user_id,COALESCE(NULLIF(u.display_name,''),u.username),s.agent_name,s.client_name,s.role,s.parent_session_id,s.resumes_session_id,s.created_at,s.last_seen_at,s.closed_at FROM work_claims c JOIN work_sessions s ON s.id=c.session_id AND s.space_id=c.space_id JOIN users u ON u.id=s.user_id WHERE c.space_id=? AND c.item_id IN ("+strings.Join(holders, ",")+")"), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	summaries := map[string]*WorkCollaboration{}
	for rows.Next() {
		claim := &workClaim{}
		session := &WorkSession{SpaceID: space, Actor: &WorkActivityActor{}}
		var handoff string
		if err = rows.Scan(&claim.ItemID, &claim.SpaceID, &claim.ClaimID, &claim.SessionID, &claim.Generation, &claim.ExpiresAt, &claim.LastSeenAt, &claim.LastProgressAt, &claim.ReleasedAt, &claim.Unresolved, &handoff, &session.Actor.ID, &session.Actor.Name, &session.AgentName, &session.ClientName, &session.Role, &session.ParentSessionID, &session.ResumesSessionID, &session.CreatedAt, &session.LastSeenAt, &session.ClosedAt); err != nil {
			return err
		}
		session.ID = claim.SessionID
		if handoff != "" {
			if err = json.Unmarshal([]byte(handoff), &claim.Handoff); err != nil {
				return err
			}
		}
		summaries[claim.ItemID] = a.workCollaborationView(r, claim, session)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for i := range items {
		if summary, found := summaries[items[i].ID]; found {
			items[i].Collaboration = summary
		} else {
			items[i].Collaboration = a.workCollaborationView(r, nil, nil)
		}
	}
	return nil
}
