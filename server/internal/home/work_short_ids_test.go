package home

import (
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWorkShortIDBoundaries(t *testing.T) {
	for _, tc := range []struct {
		n  int64
		id string
	}{
		{1, "00001"}, {9, "00009"}, {10, "0000a"}, {35, "0000z"},
		{36, "00010"}, {60466175, "zzzzz"}, {60466176, "100000"},
		{math.MaxInt64, "1y2p0ij32e8e7"},
	} {
		if got := formatWorkItemID(tc.n); got != tc.id || !workItemRefValid(got) {
			t.Fatalf("number %d: got %q, want canonical %q", tc.n, got, tc.id)
		}
	}
	for _, id := range []string{"", "00000", "0001", "000001", "0000A", "+0001", "W-1", strings.Repeat("a", 32), "zzzzzzzzzzzzz"} {
		if workItemRefValid(id) {
			t.Fatalf("accepted retired or noncanonical ID %q", id)
		}
	}
}

func TestWorkShortIDRecoveryAndScope(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			payload := map[string]any{"requestId": "recover:one", "title": "hello retained card"}
			item := f.owner.ok("POST", f.base+"/items", payload)
			id := item["id"].(string)
			if id != "00001" || item["key"] != nil || item["number"] != nil || item["requestId"] != nil {
				t.Fatal("unexpected public identity", item)
			}
			statusWant(t, f.owner, 400, "POST", f.base+"/items", map[string]any{"id": newID(), "title": "Retired create"})
			statusWant(t, f.owner, 400, "POST", f.base+"/items", map[string]any{"title": "Missing request"})
			statusWant(t, f.owner, 409, "POST", f.base+"/items", map[string]any{"requestId": "recover:one", "title": "Different intent"})
			foreignBase := "/spaces/" + f.personal + "/work"
			foreign := f.owner.ok("POST", foreignBase+"/items", payload)
			if foreign["id"] == id {
				t.Fatal("short IDs were reused across spaces")
			}
			statusWant(t, f.owner, 404, "GET", f.base+"/items/"+foreign["id"].(string), nil)
			statusWant(t, f.owner, 404, "GET", foreignBase+"/items/"+id, nil)
			for _, term := range []string{id, "hello"} {
				page := f.owner.ok("GET", f.base+"/items?q="+url.QueryEscape(term), nil)
				if page["total"] != float64(1) || workIDsFromPage(page)[0] != id {
					t.Fatal("ID/text search failed", page)
				}
			}
			item = f.owner.ok("PATCH", workItemPath(f.space, id), map[string]any{"expectedRevision": item["revision"], "archived": true})
			page := f.owner.ok("GET", f.base+"/items?requestId=recover:one", nil)
			if page["total"] != float64(1) || workIDsFromPage(page)[0] != id {
				t.Fatal("uncertain creation lookup lost an archived card", page)
			}
			page = f.owner.ok("GET", f.base+"/items?requestId=recover:one&archived=false", nil)
			if page["total"] != float64(0) {
				t.Fatal("explicit archive filter was ignored", page)
			}
			replay := f.owner.ok("POST", f.base+"/items", payload)
			if replay["id"] != id || replay["archived"] != true || replay["boardRevision"] != item["boardRevision"] {
				t.Fatal("creation replay mutated existing work", replay)
			}
			for _, bad := range []string{newID(), "W-1", "00000", "000001"} {
				statusWant(t, f.owner, 404, "GET", f.base+"/items/"+bad, nil)
				statusWant(t, f.owner, 400, "GET", f.base+"/items?itemId="+bad, nil)
			}
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			token, _ := auth.token(f.space, "", "work:read")
			caller.tool(token, "work_items_get", map[string]any{"id": foreign["id"]}, "not_found")
			caller.tool(token, "work_items_list", map[string]any{"spaceId": f.personal, "input": map[string]any{"requestId": "recover:one"}}, "not_found")
			result := caller.tool(token, "work_items_list", map[string]any{"input": map[string]any{"requestId": "recover:one"}}, "")
			if result["total"] != float64(1) {
				t.Fatal("MCP recovery lost archived card", result)
			}
			// Creation keys are private to their authenticated actor, even if
			// another actor has permission to read the card itself.
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_items SET create_user_id=? WHERE id=?"), "other-authenticated-actor", id); err != nil {
				t.Fatal(err)
			}
			page = f.owner.ok("GET", f.base+"/items?requestId=recover:one", nil)
			if page["total"] != float64(0) {
				t.Fatal("request key lookup leaked another actor's creation", page)
			}
			replacement := f.owner.ok("POST", f.base+"/items", payload)
			if replacement["id"] == id || replacement["id"] == foreign["id"] {
				t.Fatal("actor-scoped request key reused a card")
			}
		})
	}
}

func TestWorkShortIDConcurrentCreation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			const unique = 16
			type outcome struct {
				key     string
				code    int
				value   map[string]any
				elapsed time.Duration
			}
			outcomes := make(chan outcome, unique*2)
			start := make(chan struct{})
			var workers sync.WaitGroup
			for i := 0; i < unique*2; i++ {
				workers.Add(1)
				go func(index int) {
					defer workers.Done()
					key := fmt.Sprintf("parallel:%02d", index%unique)
					<-start
					before := time.Now()
					code, body := f.owner.call("POST", f.base+"/items", map[string]any{"requestId": key, "title": "Concurrent " + key})
					outcomes <- outcome{key, code, body, time.Since(before)}
				}(i)
			}
			close(start)
			workers.Wait()
			close(outcomes)
			byKey := map[string]string{}
			byID := map[string]string{}
			durations := []float64{}
			for result := range outcomes {
				if result.code != 200 {
					t.Fatalf("parallel create %s status=%d: %v", result.key, result.code, result.value)
				}
				id, _ := result.value["id"].(string)
				if !workItemRefValid(id) {
					t.Fatalf("invalid allocated short ID %q", id)
				}
				if old, ok := byKey[result.key]; ok && old != id {
					t.Fatal("one request created multiple cards")
				}
				if old, ok := byID[id]; ok && old != result.key {
					t.Fatal("different requests collided")
				}
				byKey[result.key], byID[id] = id, result.key
				durations = append(durations, float64(result.elapsed.Microseconds())/1000)
			}
			if len(byID) != unique {
				t.Fatal("wrong concurrent card count", len(byID))
			}
			page := f.owner.ok("GET", f.base+"/items?limit=5", nil)
			ids := map[string]bool{}
			for {
				for _, id := range workIDsFromPage(page) {
					if ids[id] {
						t.Fatal("duplicate short-ID page item", id)
					}
					ids[id] = true
				}
				cursor, _ := page["nextCursor"].(string)
				if cursor == "" {
					break
				}
				page = f.owner.ok("GET", f.base+"/items?limit=5&cursor="+url.QueryEscape(cursor), nil)
			}
			if len(ids) != unique {
				t.Fatal("pagination dropped cards", len(ids))
			}
			var next int64
			if err := f.app.store.DB.QueryRow("SELECT next_number FROM work_item_sequence WHERE id=1").Scan(&next); err != nil {
				t.Fatal(err)
			}
			if next != unique+1 {
				t.Fatal("creation replay consumed sequence numbers", next)
			}
			sort.Float64s(durations)
			t.Logf("owned loopback fixture: %d parallel requests, %d unique cards, p50 %.2f ms, p95 %.2f ms", len(durations), unique, durations[len(durations)/2], durations[(len(durations)*95-1)/100])
		})
	}
}
