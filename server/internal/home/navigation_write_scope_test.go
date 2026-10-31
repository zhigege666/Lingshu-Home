package home

import (
	"net/http"
	"reflect"
	"testing"
)

func TestNavigationWriteOnlyReceipts(t *testing.T) {
	f := newDocumentFixture(t, false)
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	client := integrationBrowser(t, f.server.URL)
	base := "/api/v1/spaces/" + f.personal
	const privateNotes = "fixture: hidden operator notes"

	hidden := coreLink("Private service", "https://example.org/internal")
	hidden["contextMarkdown"] = privateNotes
	hidden["sortOrder"] = 20
	existing := owner.object("POST", base+"/links", hidden, http.StatusCreated, "")
	write, _ := owner.token(f.personal, "", "navigation:write")
	full, _ := owner.token(f.personal, "", "navigation:read", "navigation:write")

	client.tool(write, "navigation_get", map[string]any{}, "forbidden")
	client.tool(write, "bookmarks_get", map[string]any{"id": existing["id"]}, "forbidden")
	own := client.tool(write, "bookmarks_create", map[string]any{"input": coreLink("Submitted", "https://example.org/new")}, "")
	assertLinkReceipt := func(v map[string]any, id any) {
		t.Helper()
		if len(v) != 2 || v["id"] == nil || v["id"] != id || v["updatedAt"] == nil {
			t.Fatalf("expected a link write receipt, got %v", v)
		}
	}
	assertLinkReceipt(own, own["id"])

	// Reordering one's own bookmark may also change the rank of an entirely
	// unknown sibling. Both HTTP and MCP use these same mutation handlers.
	args := map[string]any{"expectedRevision": "0", "moves": []map[string]any{{"kind": "link", "id": own["id"], "categoryId": nil, "beforeId": nil}}}
	conflict := client.tool(write, "navigation_batch_edit", map[string]any{"input": args}, "navigation_version_conflict")
	args["expectedRevision"] = conflict["currentRevision"]
	changed := client.tool(write, "navigation_batch_edit", map[string]any{"input": args}, "")
	if len(changed) != 2 || changed["updatedCount"] != float64(2) || changed["revision"] == nil {
		t.Fatalf("expected only count and revision when normalizing two siblings, got %v", changed)
	}

	// HTTP and MCP update calls must not echo the stored note omitted by the caller.
	input := coreLink("Replacement title", "https://example.org/replaced")
	got := client.object("PUT", base+"/links/"+existing["id"].(string), input, http.StatusOK, write)
	assertLinkReceipt(got, existing["id"])
	got = client.tool(write, "bookmarks_update", map[string]any{"id": existing["id"], "input": input}, "")
	assertLinkReceipt(got, existing["id"])
	fullLink := client.tool(full, "bookmarks_update", map[string]any{"id": existing["id"], "input": input}, "")
	if fullLink["contextMarkdown"] != privateNotes || fullLink["url"] != input["url"] {
		t.Fatal("read/write PAT did not receive complete stored bookmark")
	}

	category := client.tool(write, "categories_create", map[string]any{"input": map[string]any{"name": "Submitted category"}}, "")
	if len(category) != 1 || category["id"] == nil {
		t.Fatalf("expected category ID receipt, got %v", category)
	}
	fullNav := client.tool(full, "navigation_get", map[string]any{}, "")
	patch := map[string]any{"expectedRevision": fullNav["revision"], "links": []map[string]any{{"id": own["id"], "patch": map[string]any{"title": "New title"}}}}
	fullBatch := client.object("POST", base+"/navigation/batch-edit", patch, http.StatusOK, full)
	if rows := fullBatch["links"].([]any); len(rows) != 1 || integrationObject(t, rows[0])["title"] != "New title" {
		t.Fatal("read/write PAT did not receive complete changed rows")
	}
}

func TestNavigationWriteOnlyErrorTargets(t *testing.T) {
	input := navigationEditInput{Links: []navigationEditRow{{ID: "mine"}}, Moves: []navigationEditMove{{Kind: "category", ID: "moved"}}}
	for _, tc := range []struct {
		entity, id string
		reported   bool
	}{
		{"link", "mine", true}, {"category", "moved", true},
		{"category", "mine", false}, {"link", "unknown-sibling", false},
	} {
		original := &APIError{Status: 409, Code: "navigation_version_conflict", Message: "Reload the bookmark list.", CurrentRevision: "42", Entity: tc.entity, ID: tc.id, Field: "sortOrder"}
		want := *original
		if !tc.reported {
			want.Entity, want.ID, want.Field = "", "", ""
		}
		if err := input.writeOnlyError(original); !reflect.DeepEqual(err, &want) {
			t.Fatalf("unexpected write-only detail for %s: %v", tc.id, err)
		}
	}
}
