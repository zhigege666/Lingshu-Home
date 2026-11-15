package home

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkCollaborationBatchedSummary(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			session := f.session("Batch owner")
			stamp := workStamp()
			expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			tx, err := f.app.store.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			items := make([]WorkSummary, 120)
			firstID := reserveWorkTestIDs(t, f.app.store, tx, len(items))
			for i := range items {
				id := formatWorkItemID(firstID + int64(i))
				items[i] = WorkSummary{ID: id, SpaceID: f.space}
				if _, err = tx.Exec(f.app.store.Query("INSERT INTO work_items(id,space_id,title,status,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,'todo',?,1,?,?,'summary-fixture')"), id, f.space, "Batched card", i*1024, stamp, stamp); err != nil {
					tx.Rollback()
					t.Fatal(err)
				}
				released := ""
				if i%2 == 1 {
					released = stamp
				}
				if _, err = tx.Exec(f.app.store.Query("INSERT INTO work_claims(item_id,space_id,claim_id,session_id,generation,expires_at,last_seen_at,released_at) VALUES(?,?,?,?,1,?,?,?)"), id, f.space, newID(), session["id"], expires, stamp, released); err != nil {
					tx.Rollback()
					t.Fatal(err)
				}
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			measure := func(cards []*WorkSummary, enabled bool) int {
				t.Helper()
				q := &workMeasuredQueries{Queryer: f.app.store.DB}
				r := &Request{App: f.app, HTTP: httptest.NewRequest("GET", "/", nil), Q: q}
				r.Settings.MCP.CollaborationEnabled = enabled
				if err := f.app.decorateWorkCollaboration(r, f.space, cards); err != nil {
					t.Fatal(err)
				}
				return q.Count
			}
			refs := workSummaryPointers(items)
			small := measure(refs[:1], true)
			large := measure(refs, true)
			if small != 1 || large != 1 {
				t.Fatalf("collaboration queries grow per card: one=%d 120=%d", small, large)
			}
			for i, item := range items {
				want := "active"
				if i%2 == 1 {
					want = "released"
				}
				if item.Collaboration == nil || !item.Collaboration.Enabled || item.Collaboration.State != want || item.Collaboration.Session == nil || item.Collaboration.Session.ID != session["id"] {
					t.Fatalf("batched card %d lost owner or history", i)
				}
			}
			// Exercise the maximum board projection without multiplying fixture writes:
			// only the first 120 visible cards have persisted claims.
			maximum := make([]*WorkSummary, workStatusLimit*100)
			copy(maximum, refs)
			for i := len(refs); i < len(maximum); i++ {
				maximum[i] = &WorkSummary{ID: formatWorkItemID(firstID + int64(i)), SpaceID: f.space}
			}
			wantBatches := (len(maximum) + workCollaborationBatchSize - 1) / workCollaborationBatchSize
			if queries := measure(maximum, true); queries != wantBatches {
				t.Fatalf("maximum board claim queries=%d, want %d bounded batches", queries, wantBatches)
			}
			for _, item := range maximum[len(refs):] {
				if item.Collaboration == nil || !item.Collaboration.Enabled || item.Collaboration.State != "unclaimed" {
					t.Fatal("maximum projection lost a card without a claim")
				}
			}
			unclaimed := maximum[len(maximum)-1]
			measure(append(refs, unclaimed), false)
			for _, item := range items {
				if item.Collaboration == nil || item.Collaboration.Enabled {
					t.Fatal("disabled flag hid persisted claim history or was ignored")
				}
			}
			if unclaimed.Collaboration != nil {
				t.Fatal("disabled flag retained unclaimed collaboration projection")
			}
		})
	}
}
