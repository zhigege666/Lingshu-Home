package home

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The public producer examples must remain accepted by the production
// normalizer. Reading the repository files also detects missing release/CI
// source inputs; the example data is never embedded or seeded by the app.
func TestDashboardDataExamplesMatchContracts(t *testing.T) {
	base := filepath.Join("..", "..", "..", "examples", "dashboard-data")
	raw, err := os.ReadFile(filepath.Join(base, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var index struct {
		Format              string `json:"format"`
		IndexVersion        int    `json:"indexVersion"`
		ExampleCollectedAt  string `json:"exampleCollectedAt"`
		AutomaticallyLoaded bool   `json:"automaticallyLoaded"`
		Contracts           []struct {
			SchemaID      string                 `json:"schemaId"`
			SchemaVersion int                    `json:"schemaVersion"`
			Renderer      string                 `json:"renderer"`
			Input         string                 `json:"input"`
			SourceCreate  integrationSourceInput `json:"sourceCreate"`
			Examples      []struct {
				File string `json:"file"`
			} `json:"examples"`
		} `json:"contracts"`
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		t.Fatal(err)
	}
	if index.Format != "lingshu-home-dashboard-data-examples" || index.IndexVersion != 1 || index.AutomaticallyLoaded {
		t.Fatal("example index must describe explicit versioned handoff data")
	}
	collected, err := time.Parse(time.RFC3339, index.ExampleCollectedAt)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][2]string{
		"metrics.summary":   {"builtin/metrics", "metrics"},
		"status.collection": {"builtin/status", "status"},
		"calendar.events":   {"builtin/calendar", "events"},
		"weather.forecast":  {"builtin/weather", "weather"},
	}
	seenSchemas, seenFiles := map[string]bool{}, map[string]bool{}
	for _, contract := range index.Contracts {
		t.Run(contract.SchemaID, func(t *testing.T) {
			pair, exists := want[contract.SchemaID]
			if !exists || seenSchemas[contract.SchemaID] || contract.SchemaVersion != 1 || contract.Renderer != pair[0] || contract.Input != pair[1] {
				t.Fatal("example contract must match a current unique renderer/schema/input pair")
			}
			seenSchemas[contract.SchemaID] = true
			in := contract.SourceCreate
			if in.Kind != "external-push" || in.SchemaID != contract.SchemaID || in.SchemaVersion != 1 || in.Enabled == nil || !*in.Enabled || in.Secret != nil {
				t.Fatal("source example must be an explicit credential-free push source for this schema")
			}
			if err := validateIntegrationConfiguration(in.Name, in.Kind, in.SchemaID, in.SchemaVersion, in.Connection, &in.Sync, in.Secret); err != nil {
				t.Fatalf("source example rejected: %v", err)
			}
			if len(contract.Examples) == 0 {
				t.Fatal("each advertised contract requires an accepted push example")
			}
			for _, example := range contract.Examples {
				t.Run(example.File, func(t *testing.T) {
					if example.File == "" || filepath.Base(example.File) != example.File || seenFiles[example.File] {
						t.Fatal("example filenames must be unique and relative to the public example directory")
					}
					seenFiles[example.File] = true
					body, err := os.ReadFile(filepath.Join(base, example.File))
					if err != nil {
						t.Fatal(err)
					}
					var push integrationPushInput
					decoder := json.NewDecoder(bytes.NewReader(body))
					decoder.DisallowUnknownFields()
					if err := decoder.Decode(&push); err != nil {
						t.Fatal(err)
					}
					if err := decoder.Decode(new(any)); err != io.EOF {
						t.Fatal("push example must contain exactly one JSON object")
					}
					if push.SchemaID != contract.SchemaID || push.SchemaVersion != 1 || !integrationExternalID.MatchString(push.RequestID) || push.ExpectedRevision == nil || *push.ExpectedRevision != "0" || push.SourceSequence != nil {
						t.Fatal("push example must target the declared schema and initial revision")
					}
					if push.SourceUpdatedAt == nil || !push.SourceUpdatedAt.Equal(collected) {
						t.Fatal("push example must retain its explicitly fixed fixture timestamp")
					}
					normalized, err := normalizeComponentData(push.SchemaID, push.Data)
					if err != nil {
						t.Fatalf("public data example rejected: %v", err)
					}
					encoded, err := json.Marshal(normalized)
					if err != nil || len(encoded) > 1<<20 {
						t.Fatalf("normalized example exceeds the accepted storage contract: %v", err)
					}
					if _, err := normalizeComponentData(push.SchemaID, encoded); err != nil {
						t.Fatalf("normalized example cannot be read back: %v", err)
					}
				})
			}
		})
	}
	if len(seenSchemas) != len(want) {
		t.Fatal("public examples must cover all four implemented component schemas")
	}
	files, err := filepath.Glob(filepath.Join(base, "*.push.json"))
	if err != nil || len(files) != len(seenFiles) {
		t.Fatal("every public push example must appear in the validated index")
	}
}
