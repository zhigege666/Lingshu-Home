package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

type workMutationCountedQueries struct {
	Queryer
	statements []string
	writes     int
}

func (q *workMutationCountedQueries) record(statement string) {
	q.statements = append(q.statements, statement)
	if strings.HasPrefix(statement, "INSERT ") || strings.HasPrefix(statement, "UPDATE ") || strings.HasPrefix(statement, "DELETE ") {
		q.writes++
	}
}
func (q *workMutationCountedQueries) QueryContext(ctx context.Context, statement string, args ...any) (*sql.Rows, error) {
	q.record(statement)
	return q.Queryer.QueryContext(ctx, statement, args...)
}
func (q *workMutationCountedQueries) QueryRowContext(ctx context.Context, statement string, args ...any) *sql.Row {
	q.record(statement)
	return q.Queryer.QueryRowContext(ctx, statement, args...)
}
func (q *workMutationCountedQueries) ExecContext(ctx context.Context, statement string, args ...any) (sql.Result, error) {
	q.record(statement)
	return q.Queryer.ExecContext(ctx, statement, args...)
}

// Count the production handler inside its normal write gate and transaction.
// Fixture authentication/setup are excluded, as in the existing board budget.
func measureWorkMutation(t *testing.T, f *workStatusFixture, id string, body any, handler handlerFunc) (*Response, *workMutationCountedQueries, error) {
	t.Helper()
	userID := f.owner.bootstrap()["user"].(map[string]any)["id"].(string)
	f.app.writeGate <- struct{}{}
	defer func() { <-f.app.writeGate }()
	ctx := context.Background()
	tx, err := f.app.store.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	settings, err := f.app.loadSettings(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	user, err := f.app.loadUser(ctx, tx, userID)
	if err != nil {
		t.Fatal(err)
	}
	counted := &workMutationCountedQueries{Queryer: tx}
	r := &Request{App: f.app, HTTP: httptest.NewRequest("PATCH", "http://fixture/work", nil), Q: counted, Settings: settings, User: user, Params: map[string]string{"spaceId": f.space, "id": id}, Input: []byte(jsonString(body))}
	response, err := handler(r)
	if err != nil {
		return response, counted, err
	}
	return response, counted, tx.Commit()
}

func workMutationBudgetItem(t *testing.T, response *Response, measured *workMutationCountedQueries, err error, budget int) *WorkItem {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if len(measured.statements) > budget {
		t.Fatalf("work mutation used %d SQL calls, budget %d: %v", len(measured.statements), budget, measured.statements)
	}
	item, ok := response.Data.(*WorkItem)
	if !ok {
		t.Fatalf("expected item response, got %T", response.Data)
	}
	t.Logf("status=%s SQL=%d writes=%d", item.Status, len(measured.statements), measured.writes)
	return item
}

func TestWorkMutationPreparedQueryBudget(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			created := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": "Measured cycle", "status": "todo"})
			id := created["id"].(string)
			response, measured, err := measureWorkMutation(t, f, id, map[string]any{"expectedRevision": "1", "status": "doing"}, f.app.updateWorkItem)
			doing := workMutationBudgetItem(t, response, measured, err, 14)
			if doing.Revision != "2" || measured.writes != 4 {
				t.Fatal("status change must retain item, history, metric and board writes")
			}
			// A later transaction must observe a changed catalog. Its immutable
			// history snapshot must use the new name, not a cached prior reply.
			catalog := f.owner.ok("GET", f.base+"/statuses", nil)
			f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": "doing", "name": "Renamed active state"}}})
			board := f.owner.ok("GET", f.base+"/revision", nil)
			response, measured, err = measureWorkMutation(t, f, id, map[string]any{"expectedRevision": "2", "status": "doing"}, f.app.updateWorkItem)
			unchanged := workMutationBudgetItem(t, response, measured, err, 9)
			if unchanged.Revision != "2" || unchanged.BoardRevision != board["revision"] || unchanged.StatusDefinition.Name != "Renamed active state" || measured.writes != 0 {
				t.Fatal("no-op changed business state or reused a prior transaction catalog")
			}
			response, measured, err = measureWorkMutation(t, f, id, map[string]any{"expectedRevision": "2", "status": "done"}, f.app.updateWorkItem)
			done := workMutationBudgetItem(t, response, measured, err, 14)
			if done.Revision != "3" || done.StatusDefinition.Type != "done" || measured.writes != 4 {
				t.Fatal("completion lost its revision, status semantics or metric write")
			}
			_, measured, err = measureWorkMutation(t, f, id, map[string]any{"expectedRevision": "1", "status": "waiting"}, f.app.updateWorkItem)
			var api *APIError
			if !errors.As(err, &api) || api.Code != "work_item_version_conflict" || measured.writes != 0 {
				t.Fatal("stale item revision bypassed mutation protection", err)
			}
			var activities, cycles, unfinished int
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_activity WHERE item_id=?"), id).Scan(&activities); err != nil {
				t.Fatal(err)
			}
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*),COALESCE(SUM(CASE WHEN ended_at='' OR started_at='' OR valid=FALSE THEN 1 ELSE 0 END),0) FROM work_metric_intervals WHERE item_id=? AND kind='cycle'"), id).Scan(&cycles, &unfinished); err != nil {
				t.Fatal(err)
			}
			if activities != 3 || cycles != 1 || unfinished != 0 {
				t.Fatalf("lost or duplicated real history: activities=%d cycles=%d invalid/open=%d", activities, cycles, unfinished)
			}
			var encoded string
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT changes_json FROM work_activity WHERE item_id=? AND item_revision=3"), id).Scan(&encoded); err != nil {
				t.Fatal(err)
			}
			var changes []WorkActivityChange
			if err = json.Unmarshal([]byte(encoded), &changes); err != nil {
				t.Fatal(err)
			}
			var before struct{ Name string }
			if len(changes) != 1 || changes[0].Field != "status" || json.Unmarshal(changes[0].Before, &before) != nil || before.Name != "Renamed active state" {
				t.Fatal("status history did not retain the current catalog name", encoded)
			}
		})
	}
}

func TestWorkMutationPreparedContextReply(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Context reference", "https://example.com/context-reference"))
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": "Claimed measured completion", "status": "doing", "bookmarkIds": []string{link["id"].(string)}})
			session := f.session("Measured session")
			claim := f.claim(item, session)
			id := item["id"].(string)
			input := map[string]any{"expectedRevision": item["revision"], "status": "done", "context": collabCoreContext(session, claim)}
			response, measured, err := measureWorkMutation(t, f.workStatusFixture, id, input, f.app.updateWorkItem)
			done := workMutationBudgetItem(t, response, measured, err, 22)
			if done.Collaboration == nil || done.Collaboration.State != "released" || len(done.References) != 1 || len(done.BookmarkIDs) != 1 {
				t.Fatal("final reply must include the released claim and one copy of references")
			}
			response, measured, err = measureWorkMutation(t, f.workStatusFixture, id, input, f.app.updateWorkItem)
			if err != nil {
				t.Fatal(err)
			}
			receipt, ok := response.Data.(map[string]any)
			if !ok || len(receipt) != 4 || receipt["replayed"] != true || receipt["revision"] != done.Revision || receipt["boardRevision"] != done.BoardRevision || measured.writes != 0 || len(measured.statements) > 4 {
				t.Fatal("replay must precede the released-claim guard and retain a restricted original receipt", response.Data)
			}
			var events, activities, completed int
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_collaboration_events WHERE item_id=? AND kind='item_completed'"), id).Scan(&events); err != nil {
				t.Fatal(err)
			}
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_activity WHERE item_id=?"), id).Scan(&activities); err != nil {
				t.Fatal(err)
			}
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_metric_intervals WHERE item_id=? AND kind='cycle' AND ended_at<>'' AND valid=TRUE"), id).Scan(&completed); err != nil {
				t.Fatal(err)
			}
			if events != 1 || activities != 2 || completed != 1 {
				t.Fatal("context completion or replay lost/duplicated transactional records", events, activities, completed)
			}
		})
	}
}

func TestWorkEmptyReferenceMutationQueries(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			requestID := newID()
			body := map[string]any{"requestId": requestID, "title": "Empty references"}
			response, measured, err := measureWorkMutation(t, f, "", body, f.app.createWorkItem)
			if err != nil {
				t.Fatal(err)
			}
			created := response.Data.(*WorkItem)
			id := created.ID
			if !workItemRefValid(id) || id == requestID {
				t.Fatal("creation did not return a server-assigned short item ID")
			}
			for _, statement := range measured.statements {
				for _, prefix := range []string{"DELETE FROM work_item_links", "DELETE FROM work_item_documents", "SELECT link_id FROM work_item_links", "SELECT document_id FROM work_item_documents"} {
					if strings.HasPrefix(statement, prefix) {
						t.Fatal("new empty item performed redundant reference work", statement)
					}
				}
			}
			response, measured, err = measureWorkMutation(t, f, "", body, f.app.createWorkItem)
			if err != nil || response.Data.(*WorkItem).ID != id || response.Data.(*WorkItem).Revision != created.Revision || measured.writes != 0 {
				t.Fatal("empty-reference creation changed its original replay", err)
			}
			f.owner.ok("PUT", "/settings", map[string]any{"siteName": "Reference module guard", "mode": ModePublicRead, "registrationEnabled": false, "modules": map[string]any{"documents": false}})
			for _, operation := range []string{"create", "update"} {
				input := map[string]any{"documentIds": []string{}}
				handler := f.app.updateWorkItem
				if operation == "create" {
					input["requestId"], input["title"] = newID(), "Explicit disabled documents"
					handler = f.app.createWorkItem
				} else {
					input["expectedRevision"] = created.Revision
				}
				_, measured, err = measureWorkMutation(t, f, id, input, handler)
				var api *APIError
				if !errors.As(err, &api) || api.Code != "module_disabled" || measured.writes != 0 {
					t.Fatal("explicit empty documentIds bypassed the disabled module", operation, err)
				}
			}
			plain := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": "Omitted disabled documents"})
			if plain["revision"] != "1" {
				t.Fatal("plain creation failed while documents were disabled")
			}
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Real reference", "https://example.com/real-reference"))
			linked := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": "Nonempty references", "bookmarkIds": []string{link["id"].(string)}})
			if len(linked["references"].([]any)) != 1 {
				t.Fatal("nonempty reference creation was skipped")
			}
			cleared := f.owner.ok("PATCH", workItemPath(f.space, linked["id"].(string)), map[string]any{"expectedRevision": linked["revision"], "bookmarkIds": []string{}})
			if len(cleared["references"].([]any)) != 0 || cleared["revision"] == linked["revision"] {
				t.Fatal("explicit empty reference update failed to remove an existing relation")
			}
		})
	}
}
