package home

import "strings"

func defaultPageChrome() map[string]any {
	return map[string]any{
		"header": map[string]any{"enabled": false, "left": []any{}, "center": []any{}, "right": []any{}},
		"footer": map[string]any{"enabled": true, "left": []any{}, "center": []any{}, "right": []any{map[string]any{"id": "home-branding", "type": "branding"}}},
	}
}

func validatePageChrome(raw any) error {
	chrome, ok := object(raw)
	if !ok || !keysOnly(chrome, "header", "footer") || len(chrome) != 2 {
		return invalid("Page chrome requires header and footer regions.")
	}
	ids := map[string]bool{}
	for _, region := range []string{"header", "footer"} {
		area, ok := object(chrome[region])
		if !ok || !keysOnly(area, "enabled", "left", "center", "right") {
			return invalid("Invalid page chrome region.")
		}
		if _, ok = area["enabled"].(bool); !ok {
			return invalid("Page chrome enabled must be a boolean.")
		}
		for _, alignment := range []string{"left", "center", "right"} {
			items, ok := area[alignment].([]any)
			if !ok || len(items) > 8 {
				return invalid("Each page chrome slot must contain at most 8 items.")
			}
			for _, rawItem := range items {
				item, ok := object(rawItem)
				if !ok || !keysOnly(item, "id", "type", "text", "url", "newTab") {
					return invalid("Unknown page chrome item field.")
				}
				id, ok := item["id"].(string)
				if !ok || ids[id] {
					return invalid("Page chrome item IDs must be unique strings.")
				}
				if trimmed, err := required(id, "Page chrome item ID", 80); err != nil || trimmed != id {
					return invalid("Page chrome item ID must contain 1–80 characters without surrounding whitespace.")
				}
				ids[id] = true
				switch item["type"] {
				case "branding":
					if !keysOnly(item, "id", "type") {
						return invalid("Branding items do not accept custom text or URLs.")
					}
				case "text", "link":
					limit := 500
					if item["type"] == "link" {
						limit = 160
					}
					text, ok := item["text"].(string)
					if !ok || strings.TrimSpace(text) == "" {
						return invalid("Page chrome text must not be empty.")
					}
					if err := bounded(text, "Page chrome text", limit); err != nil {
						return err
					}
					if item["type"] == "text" {
						if !keysOnly(item, "id", "type", "text") {
							return invalid("Text items do not accept link options.")
						}
						continue
					}
					url, ok := item["url"].(string)
					if !ok || bounded(url, "Page chrome URL", 2048) != nil {
						return invalid("Page chrome URL must be at most 2048 characters.")
					}
					if _, err := canonicalURL(url); err != nil {
						return err
					}
					if value, exists := item["newTab"]; exists {
						if _, ok := value.(bool); !ok {
							return invalid("Page chrome newTab must be a boolean.")
						}
					}
				default:
					return invalid("Unsupported page chrome item type.")
				}
			}
		}
	}
	return nil
}
