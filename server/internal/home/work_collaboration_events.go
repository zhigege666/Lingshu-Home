package home

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type WorkCollaborationEvent struct {
	ID          string                  `json:"id"`
	Sequence    string                  `json:"sequence"`
	ItemID      string                  `json:"itemId"`
	OperationID string                  `json:"operationId"`
	Kind        string                  `json:"kind"`
	Body        string                  `json:"body"`
	OccurredAt  string                  `json:"occurredAt"`
	Origin      string                  `json:"origin"`
	Actor       *WorkActivityActor      `json:"actor"`
	Session     *WorkSessionAttribution `json:"session,omitempty"`
	Handoff     *WorkHandoff            `json:"handoff,omitempty"`
}
type WorkCollaborationEventPage struct {
	ItemID        string                   `json:"itemId"`
	Items         []WorkCollaborationEvent `json:"items"`
	HighWatermark string                   `json:"highWatermark"`
	NextCursor    *string                  `json:"nextCursor"`
	NextAfter     string                   `json:"nextAfter"`
}

func (a *App) insertWorkEvent(r *Request, space, item, operation, kind, body string, session *WorkSession, handoff *WorkHandoff) (*WorkCollaborationEvent, error) {
	seq, err := a.nextWorkCollaborationSequence(r, space)
	if err != nil {
		return nil, err
	}
	event := &WorkCollaborationEvent{ID: newID(), Sequence: strconv.FormatInt(seq, 10), ItemID: item, OperationID: operation, Kind: kind, Body: body, OccurredAt: workStamp(), Origin: documentActivityOrigin(r), Session: workSessionSnapshot(session), Handoff: handoff}
	var actor any
	if r.User != nil {
		actor = r.User.ID
		name := r.User.DisplayName
		if name == "" {
			name = r.User.Username
		}
		event.Actor = &WorkActivityActor{ID: r.User.ID, Name: name}
	}
	sessionJSON, handoffJSON := "", ""
	if event.Session != nil {
		sessionJSON = jsonString(event.Session)
	}
	if handoff != nil {
		handoffJSON = jsonString(handoff)
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_collaboration_events(id,space_id,item_id,sequence,operation_id,actor_id,session_json,kind,body,occurred_at,origin,handoff_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"), event.ID, space, item, seq, operation, actor, sessionJSON, kind, body, event.OccurredAt, event.Origin, handoffJSON)
	return event, err
}
func (a *App) appendWorkEvent(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		OperationID string `json:"operationId"`
		SessionID   string `json:"sessionId"`
		Kind        string `json:"kind"`
		Body        string `json:"body"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.Kind != "progress" && in.Kind != "note" && in.Kind != "question" && in.Kind != "review" && in.Kind != "decision" {
		return nil, invalid("kind must be progress, note, question, review or decision.")
	}
	if in.Body, err = required(in.Body, "body", 4000); err != nil {
		return nil, err
	}
	var session *WorkSession
	if in.SessionID != "" {
		session, err = a.loadWorkSession(r, s.ID, in.SessionID, true)
		if err != nil {
			return nil, err
		}
	} else if r.Bearer {
		return nil, workCollabError("work_session_required", "A business work session is required for an Agent event. Register or resume a session in this authorized space.")
	}
	hash := workOperationHash("event.append", item.ID, in)
	if resp, e := a.workOperationReplay(r, s.ID, in.OperationID, hash); e != nil || resp != nil {
		return resp, e
	}
	if session != nil {
		if err = requireOpenWorkSession(session); err != nil {
			return nil, err
		}
	}
	claim, err := a.loadWorkClaim(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	if !a.config.MCPCollaborationEnabled && !claim.pending() {
		return nil, workCollabError("work_collaboration_disabled", "Collaboration is disabled. Existing history remains readable; only unresolved work may receive recovery notes.")
	}
	event, err := a.insertWorkEvent(r, s.ID, item.ID, in.OperationID, in.Kind, in.Body, session, nil)
	if err != nil {
		return nil, err
	}
	if session != nil {
		if err = a.touchWorkSession(r, session.ID, event.OccurredAt); err != nil {
			return nil, err
		}
		if in.Kind == "progress" && claim.live() && claim.SessionID == session.ID {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_claims SET last_progress_at=? WHERE item_id=? AND space_id=? AND generation=? AND session_id=? AND released_at=''"), event.OccurredAt, item.ID, s.ID, claim.Generation, session.ID)
			if err != nil {
				return nil, err
			}
		}
	}
	if err = a.saveWorkOperation(r, s.ID, in.OperationID, hash, event); err != nil {
		return nil, err
	}
	return ok(event), nil
}

type workEventsCursor struct {
	Space     string `json:"s"`
	Item      string `json:"i"`
	Principal string `json:"p"`
	Snapshot  int64  `json:"h"`
	After     int64  `json:"a"`
	Limit     int    `json:"l"`
	Expires   int64  `json:"e"`
}

func (a *App) workEventsPrincipal(r *Request) string {
	// The fingerprint changes when the credential or its effective scopes change.
	// The stored/public cursor never contains a token or its stored hash.
	return workPayloadHash(struct {
		User       string
		Bearer     bool
		Credential string
		Actions    map[string]bool
	}{r.User.ID, r.Bearer, r.BearerTokenHash, r.AllowedActions})
}
func (a *App) encodeWorkEventsCursor(c workEventsCursor) string {
	body := []byte(jsonString(c))
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte("home.work.events.v1\x00"))
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (a *App) decodeWorkEventsCursor(value string) (*workEventsCursor, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 || len(value) > 2048 {
		return nil, invalid("Invalid events cursor.")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, invalid("Invalid events cursor.")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, invalid("Invalid events cursor.")
	}
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte("home.work.events.v1\x00"))
	mac.Write(body)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, invalid("Invalid events cursor signature.")
	}
	var c workEventsCursor
	if err = json.Unmarshal(body, &c); err != nil || c.After < 0 || c.Snapshot < c.After || c.Limit < 1 || c.Limit > 100 || c.Expires < time.Now().Unix() {
		return nil, invalid("Events cursor expired or is invalid. Start a new snapshot from the last consumed sequence.")
	}
	return &c, nil
}
func (a *App) listWorkEvents(r *Request) (*Response, error) {
	s, err := r.workCollaborationSpace(false)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		Limit  int    `json:"limit"`
		Cursor string `json:"cursor"`
		After  string `json:"after"`
	}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Cursor = q.Get("cursor")
		in.After = q.Get("after")
		if q.Has("limit") {
			in.Limit, err = strconv.Atoi(q.Get("limit"))
			if err != nil || in.Limit < 1 {
				return nil, invalid("limit must be between 1 and 100.")
			}
		}
	}
	if in.Limit < 0 || in.Limit > 100 {
		return nil, invalid("limit must be between 1 and 100.")
	}
	if in.Cursor != "" && in.After != "" {
		return nil, invalid("cursor and after cannot be combined.")
	}
	c := &workEventsCursor{Space: s.ID, Item: item.ID, Principal: a.workEventsPrincipal(r), Limit: in.Limit, Expires: time.Now().Add(24 * time.Hour).Unix()}
	if c.Limit == 0 {
		c.Limit = 30
	}
	if in.Cursor != "" {
		c, err = a.decodeWorkEventsCursor(in.Cursor)
		if err != nil {
			return nil, err
		}
		if c.Space != s.ID || c.Item != item.ID || c.Principal != a.workEventsPrincipal(r) || (in.Limit != 0 && in.Limit != c.Limit) {
			return nil, invalid("This cursor belongs to a different space, item, principal, credential scope or page size.")
		}
	} else {
		rev, e := a.workCollaborationRevision(r, s.ID)
		if e != nil {
			return nil, e
		}
		c.Snapshot, _ = strconv.ParseInt(rev, 10, 64)
		if in.After != "" {
			c.After, err = workGeneration(in.After)
			if err != nil {
				return nil, err
			}
			if c.After > c.Snapshot {
				return nil, invalid("after cannot be ahead of the current event watermark.")
			}
		}
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT e.id,e.sequence,e.operation_id,e.kind,e.body,e.occurred_at,e.origin,e.actor_id,COALESCE(NULLIF(u.display_name,''),u.username,''),e.session_json,e.handoff_json FROM work_collaboration_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.space_id=? AND e.item_id=? AND e.sequence>? AND e.sequence<=? ORDER BY e.sequence LIMIT ?"), s.ID, item.ID, c.After, c.Snapshot, c.Limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &WorkCollaborationEventPage{ItemID: item.ID, Items: []WorkCollaborationEvent{}, HighWatermark: strconv.FormatInt(c.Snapshot, 10), NextAfter: strconv.FormatInt(c.Snapshot, 10)}
	for rows.Next() {
		event := WorkCollaborationEvent{ItemID: item.ID}
		var seq int64
		var actor sql.NullString
		var name, sessionJSON, handoffJSON string
		if err = rows.Scan(&event.ID, &seq, &event.OperationID, &event.Kind, &event.Body, &event.OccurredAt, &event.Origin, &actor, &name, &sessionJSON, &handoffJSON); err != nil {
			return nil, err
		}
		event.Sequence = strconv.FormatInt(seq, 10)
		if actor.Valid {
			event.Actor = &WorkActivityActor{ID: actor.String, Name: name}
		}
		if sessionJSON != "" {
			if err = json.Unmarshal([]byte(sessionJSON), &event.Session); err != nil {
				return nil, err
			}
		}
		if handoffJSON != "" {
			if err = json.Unmarshal([]byte(handoffJSON), &event.Handoff); err != nil {
				return nil, err
			}
		}
		page.Items = append(page.Items, event)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Items) > c.Limit {
		page.Items = page.Items[:c.Limit]
		last := page.Items[len(page.Items)-1]
		c.After, _ = strconv.ParseInt(last.Sequence, 10, 64)
		cursor := a.encodeWorkEventsCursor(*c)
		page.NextCursor = &cursor
		page.NextAfter = last.Sequence
	}
	return ok(page), nil
}
