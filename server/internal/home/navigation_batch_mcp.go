package home

// The patch schema deliberately excludes usage-note replacement and row creation.
// The same handler enforces transaction, space permission and revision checks for
// browser, bearer HTTP and MCP calls.
func navigationBatchEditSchema(link, category map[string]any) map[string]any {
	patch := func(source map[string]any, excluded ...string) map[string]any {
		props := map[string]any{}
		for key, value := range source["properties"].(map[string]any) {
			keep := true
			for _, omit := range excluded {
				if key == omit {
					keep = false
				}
			}
			if keep {
				props[key] = value
			}
		}
		value := integrationObjectSchema(props)
		value["required"] = []string{}
		value["minProperties"] = 1
		return value
	}
	id := map[string]any{"type": "string", "minLength": 1, "maxLength": 128}
	nullableID := map[string]any{"type": []string{"string", "null"}, "minLength": 1, "maxLength": 128}
	rows := func(fields map[string]any) map[string]any {
		return map[string]any{"type": "array", "maxItems": maxBatchLinks, "items": integrationObjectSchema(map[string]any{"id": id, "patch": fields}, "id", "patch")}
	}
	move := map[string]any{"anyOf": []any{
		integrationObjectSchema(map[string]any{"kind": map[string]any{"const": "category"}, "id": id, "beforeId": nullableID}, "kind", "id", "beforeId"),
		integrationObjectSchema(map[string]any{"kind": map[string]any{"const": "link"}, "id": id, "beforeId": nullableID, "categoryId": nullableID}, "kind", "id", "beforeId", "categoryId"),
	}}
	return integrationObjectSchema(map[string]any{
		"expectedRevision": map[string]any{"type": "string", "minLength": 1, "maxLength": 30},
		"categories":       rows(patch(category)),
		"links":            rows(patch(link, "contextMarkdown", "expectedUpdatedAt")),
		"moves":            map[string]any{"type": "array", "maxItems": maxBatchLinks, "items": move},
	}, "expectedRevision")
}
