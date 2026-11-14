package home

import (
	"context"
	"testing"
	"time"
)

// The worker's real HTTP behavior is exercised separately. These fixtures test
// the public summary contract across successive receipts for the same item.
func TestWorkExecutionSummaryUsesLatestReceipt(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			f.app.cancel()
			f.app.workers.Wait()
			executor := automationObject(f.owner.ok("POST", f.base+"/executors", map[string]any{"id": newID(), "name": "Summary fixture", "endpoint": "https://example.com/executor", "resourceKey": "summary:resource", "enabled": true, "secret": map[string]any{"bearerToken": "summary-fixture-credential"}}), "executor")
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "One item, successive receipts"})
			start := func() map[string]any {
				return automationObject(f.owner.ok("POST", f.base+"/executions", map[string]any{"id": newID(), "executorId": executor["id"], "itemId": item["id"], "expectedItemRevision": item["revision"]}), "execution")
			}
			outcome := func(id, state string) {
				t.Helper()
				err := f.app.integrationTransaction(context.Background(), func(q Queryer) error {
					v, err := scanWorkExecution(q.QueryRowContext(context.Background(), f.app.store.Query("SELECT "+workExecutionColumns+" FROM work_executions WHERE id=?"), id))
					if err != nil {
						return err
					}
					out := workExecutionOutcome{state: state, code: "summary_fixture", message: "Controlled receipt fixture"}
					if state == "failed" {
						out.finished = workScheduleStamp(time.Now())
					}
					return f.app.writeWorkExecutionOutcome(automationInternalRequest(context.Background(), f.app, q, Settings{}), v, out)
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			check := func(failed, unknown float64) {
				t.Helper()
				summary := f.owner.ok("GET", f.base+"/notifications/summary", nil)
				current := automationObject(summary, "spaceFailures")
				if summary["enabled"] != false || summary["unreadCount"] != float64(0) || current["executionFailed"] != failed || current["executionUnknown"] != unknown {
					t.Fatal("summary confused current failures with notification counts or old receipts", summary)
				}
			}
			first := start()
			outcome(first["id"].(string), "failed")
			check(1, 0)
			second := start()
			outcome(second["id"].(string), "unknown")
			check(0, 1)
			second = automationObject(f.owner.ok("GET", f.base+"/executions/"+second["id"].(string), nil), "execution")
			f.owner.ok("POST", f.base+"/executions/"+second["id"].(string)+"/resolve", map[string]any{"expectedRevision": second["revision"], "outcome": "succeeded", "note": "The controlled fixture confirms external work stopped.", "externalStoppedConfirmed": true})
			check(0, 0)
			var historical int
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_executions WHERE item_id=? AND state='failed'"), item["id"]).Scan(&historical); err != nil || historical != 1 {
				t.Fatal("summary erased historical failures instead of selecting the current receipt", historical, err)
			}
		})
	}
}
