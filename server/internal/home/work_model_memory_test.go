package home

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestWorkModelMemoryLayout(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_MODEL_MEMORY") != "1" {
		t.Skip("opt-in model layout measurement")
	}
	summary := reflect.TypeOf(WorkSummary{})
	fields := map[string]uintptr{}
	for i := 0; i < summary.NumField(); i++ {
		field := summary.Field(i)
		fields[field.Name] = field.Type.Size()
	}
	ordinaryJSON, err := json.Marshal(WorkSummary{})
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]any{
		"emptyOrdinarySummaryJSONBytes": len(ordinaryJSON),
		"emptyOrdinarySummaryJSON":      string(ordinaryJSON),
		"workSummaryStructBytes":        summary.Size(),
		"workItemStructBytes":           reflect.TypeOf(WorkItem{}).Size(),
		"workSummaryInlineFieldBytes":   fields,
		"scope":                         "Go inline struct layout only, including string headers/pointers; excludes backing string contents, slices, database caches, and runtime allocations.",
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
	if file := os.Getenv("LINGSHU_WORK_MODEL_MEMORY_OUTPUT"); file != "" {
		if err = os.WriteFile(file, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
}
