package home

import (
	"bytes"
	"encoding/json"
	"html"
	"strings"
	"unicode"
	"unicode/utf8"

	xhtml "golang.org/x/net/html"
)

type bookmarkInput struct {
	HTML             string  `json:"html"`
	DuplicatePolicy  string  `json:"duplicatePolicy"`
	TargetCategoryID *string `json:"targetCategoryId"`
}

type bookmarkItem struct {
	Title      string   `json:"title"`
	URL        string   `json:"url"`
	FolderPath []string `json:"folderPath"`
	Status     string   `json:"status"`
	canonical  string
}

type parsedBookmarks struct {
	Items   []bookmarkItem
	Folders [][]string
}

type bookmarkPreview struct {
	Total      int            `json:"total"`
	Valid      int            `json:"valid"`
	Duplicates int            `json:"duplicates"`
	Invalid    int            `json:"invalid"`
	Folders    int            `json:"folders"`
	Items      []bookmarkItem `json:"items"`
	Truncated  bool           `json:"truncated"`
}

func plainBookmarkText(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}

func nodeText(node *xhtml.Node) string {
	var out strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		if n.Type == xhtml.TextNode {
			out.WriteString(n.Data)
		}
		if n.Type == xhtml.ElementNode && (n.Data == "script" || n.Data == "style") {
			return
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return out.String()
}

func parseBookmarks(markup string) (parsedBookmarks, error) {
	result := parsedBookmarks{Items: []bookmarkItem{}, Folders: [][]string{}}
	if len(markup) > 2*1024*1024 || !utf8.ValidString(markup) {
		return result, invalid("Bookmark HTML must be valid UTF-8 and at most 2 MiB.")
	}
	document, err := xhtml.ParseWithOptions(strings.NewReader(markup), xhtml.ParseOptionEnableScripting(false))
	if err != nil {
		return result, invalid("Unable to parse bookmark HTML.")
	}
	seenFolders := map[string]bool{}
	dlCount := 0
	var walk func(*xhtml.Node, []string, *string, int) error
	walk = func(node *xhtml.Node, path []string, pending *string, depth int) error {
		if depth > 256 {
			return invalid("Bookmark HTML is nested too deeply.")
		}
		if node.Type == xhtml.ElementNode {
			switch node.Data {
			case "script", "style":
				return nil
			case "h3":
				name := plainBookmarkText(nodeText(node), 80)
				if name == "" {
					name = "Imported folder"
				}
				*pending = name
				folder := append(append([]string{}, path...), name)
				if len(folder) > 32 {
					return invalid("Bookmark folders are limited to 32 levels.")
				}
				key := strings.Join(folder, "\x00")
				if !seenFolders[key] {
					seenFolders[key] = true
					result.Folders = append(result.Folders, folder)
					if len(result.Folders) > 10000 {
						return invalid("Bookmark HTML has too many folders.")
					}
				}
				return nil
			case "dl":
				dlCount++
				if dlCount > 10001 {
					return invalid("Bookmark HTML has too many folder lists.")
				}
				childPath := append([]string{}, path...)
				if *pending != "" {
					childPath = append(childPath, *pending)
					*pending = ""
				}
				if len(childPath) > 32 {
					return invalid("Bookmark folders are limited to 32 levels.")
				}
				nextPending := ""
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					if err := walk(child, childPath, &nextPending, depth+1); err != nil {
						return err
					}
				}
				return nil
			case "a":
				if len(result.Items) >= 10000 {
					return invalid("Bookmark HTML is limited to 10000 links.")
				}
				address := ""
				for _, attribute := range node.Attr {
					if strings.EqualFold(attribute.Key, "href") {
						address = strings.TrimSpace(attribute.Val)
						break
					}
				}
				title := plainBookmarkText(nodeText(node), 160)
				if title == "" {
					title = plainBookmarkText(address, 160)
				}
				if title == "" {
					title = "Untitled bookmark"
				}
				item := bookmarkItem{Title: title, URL: address, FolderPath: append([]string{}, path...), Status: "valid"}
				item.canonical, err = canonicalURL(address)
				if err != nil {
					item.Status = "invalid"
				}
				result.Items = append(result.Items, item)
				*pending = ""
				return nil
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if err := walk(child, path, pending, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	pending := ""
	if err = walk(document, []string{}, &pending, 0); err != nil {
		return result, err
	}
	return result, nil
}

func (a *App) prepareBookmarks(r *Request, spaceID string, in *bookmarkInput) (parsedBookmarks, map[string]bool, []Category, error) {
	if in.DuplicatePolicy == "" {
		in.DuplicatePolicy = "skip"
	}
	if in.DuplicatePolicy != "skip" && in.DuplicatePolicy != "keep" {
		return parsedBookmarks{}, nil, nil, invalid("duplicatePolicy must be skip or keep.")
	}
	if in.TargetCategoryID != nil && *in.TargetCategoryID == "" {
		in.TargetCategoryID = nil
	}
	categories, err := a.readCategories(r, spaceID)
	if err != nil {
		return parsedBookmarks{}, nil, nil, err
	}
	parents := map[string]*string{}
	for _, c := range categories {
		parents[c.ID] = c.ParentID
	}
	targetDepth := 0
	if in.TargetCategoryID != nil {
		current := *in.TargetCategoryID
		for current != "" {
			parent, exists := parents[current]
			if !exists {
				return parsedBookmarks{}, nil, nil, invalid("Target category must belong to the current space.")
			}
			targetDepth++
			if targetDepth > 32 {
				return parsedBookmarks{}, nil, nil, invalid("Category hierarchy is too deep.")
			}
			if parent == nil {
				break
			}
			current = *parent
		}
	}
	parsed, err := parseBookmarks(in.HTML)
	if err != nil {
		return parsed, nil, nil, err
	}
	for _, folder := range parsed.Folders {
		if len(folder)+targetDepth > 32 {
			return parsed, nil, nil, invalid("Imported folders would exceed 32 category levels.")
		}
	}
	seen := map[string]bool{}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT canonical_url FROM links WHERE space_id=?"), spaceID)
	if err != nil {
		return parsed, nil, nil, err
	}
	for rows.Next() {
		var canonical string
		if err = rows.Scan(&canonical); err != nil {
			rows.Close()
			return parsed, nil, nil, err
		}
		seen[canonical] = true
	}
	err = rows.Err()
	rows.Close()
	return parsed, seen, categories, err
}

func (a *App) previewBookmarks(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in bookmarkInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	parsed, seen, _, err := a.prepareBookmarks(r, space.ID, &in)
	if err != nil {
		return nil, err
	}
	preview := bookmarkPreview{Total: len(parsed.Items), Folders: len(parsed.Folders), Items: []bookmarkItem{}, Truncated: len(parsed.Items) > 200}
	for _, item := range parsed.Items {
		if item.Status == "invalid" {
			preview.Invalid++
		} else {
			preview.Valid++
			if seen[item.canonical] {
				preview.Duplicates++
				item.Status = "duplicate"
			}
			seen[item.canonical] = true
		}
		if len(preview.Items) < 200 {
			preview.Items = append(preview.Items, item)
		}
	}
	return ok(preview), nil
}

func (a *App) importBookmarks(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in bookmarkInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	parsed, seen, categories, err := a.prepareBookmarks(r, space.ID, &in)
	if err != nil {
		return nil, err
	}
	created, imported, skipped, invalidCount := 0, 0, 0, 0
	byParent := map[string]string{}
	for _, category := range categories {
		parent := ""
		if category.ParentID != nil {
			parent = *category.ParentID
		}
		byParent[parent+"\x00"+category.Name] = category.ID
	}
	var ensureFolder func([]string) (*string, error)
	ensureFolder = func(path []string) (*string, error) {
		parent := ""
		if in.TargetCategoryID != nil {
			parent = *in.TargetCategoryID
		}
		for _, name := range path {
			key := parent + "\x00" + name
			if existing, ok := byParent[key]; ok {
				parent = existing
				continue
			}
			id := newID()
			var parentValue any
			if parent != "" {
				parentValue = parent
			}
			if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,?,?,?,?)"), id, space.ID, parentValue, name, "lucide:folder", len(categories)+created); err != nil {
				return nil, err
			}
			created++
			byParent[key] = id
			parent = id
		}
		if parent == "" {
			return nil, nil
		}
		return &parent, nil
	}
	for _, folder := range parsed.Folders {
		if _, err = ensureFolder(folder); err != nil {
			return nil, err
		}
	}
	for _, item := range parsed.Items {
		if item.Status == "invalid" {
			invalidCount++
			continue
		}
		if seen[item.canonical] && in.DuplicatePolicy == "skip" {
			skipped++
			continue
		}
		categoryID, err := ensureFolder(item.FolderPath)
		if err != nil {
			return nil, err
		}
		if _, err = a.insertLink(r, space.ID, linkInput{CategoryID: categoryID, Title: item.Title, URL: item.URL, Icon: "lucide:link", IconMode: "auto", Tags: []string{}, Endpoints: []Endpoint{}, SortOrder: imported}); err != nil {
			return nil, err
		}
		imported++
		seen[item.canonical] = true
	}
	if imported > 0 || created > 0 {
		if err = a.touchNavigation(r, space.ID); err != nil {
			return nil, err
		}
	}
	return ok(map[string]int{"imported": imported, "skipped": skipped, "invalid": invalidCount, "categoriesCreated": created}), nil
}

func (a *App) exportNavigation(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	format := r.HTTP.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "html" {
		return nil, invalid("Export format must be json or html.")
	}
	if format == "json" {
		if err = r.requireAction("pages:read"); err != nil {
			return nil, err
		}
	}
	data, err := a.readNavigation(r, space.ID)
	if err != nil {
		return nil, err
	}
	if format == "json" {
		page, err := a.loadPage(r, space.ID)
		if err != nil {
			return nil, err
		}
		body, err := json.MarshalIndent(map[string]any{"format": "lingshu-home.navigation", "schemaVersion": 1, "exportedAt": nowUTC(), "version": a.version, "space": space, "categories": data.Categories, "links": data.Links, "page": page}, "", "  ")
		if err != nil {
			return nil, err
		}
		r.Writer.Header().Set("Content-Disposition", `attachment; filename="lingshu-home-navigation.json"`)
		return &Response{Status: 200, Body: body, ContentType: "application/json; charset=utf-8"}, nil
	}
	var out bytes.Buffer
	out.WriteString("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Lingshu-Home bookmarks</TITLE>\n<H1>" + html.EscapeString(space.Name) + "</H1>\n<DL><p>\n")
	children := map[string][]Category{}
	links := map[string][]Link{}
	for _, category := range data.Categories {
		parent := ""
		if category.ParentID != nil {
			parent = *category.ParentID
		}
		children[parent] = append(children[parent], category)
	}
	for _, link := range data.Links {
		parent := ""
		if link.CategoryID != nil {
			parent = *link.CategoryID
		}
		links[parent] = append(links[parent], link)
	}
	var writeFolder func(string, int)
	writeFolder = func(parent string, depth int) {
		indent := strings.Repeat("    ", depth)
		for _, link := range links[parent] {
			out.WriteString(indent + "<DT><A HREF=\"" + html.EscapeString(link.URL) + "\">" + html.EscapeString(link.Title) + "</A>\n")
			for _, endpoint := range link.Endpoints {
				out.WriteString(indent + "<DT><A HREF=\"" + html.EscapeString(endpoint.URL) + "\">" + html.EscapeString(link.Title+" — "+endpoint.Label) + "</A>\n")
			}
		}
		for _, category := range children[parent] {
			out.WriteString(indent + "<DT><H3>" + html.EscapeString(category.Name) + "</H3>\n" + indent + "<DL><p>\n")
			writeFolder(category.ID, depth+1)
			out.WriteString(indent + "</DL><p>\n")
		}
	}
	writeFolder("", 1)
	out.WriteString("</DL><p>\n")
	r.Writer.Header().Set("Content-Disposition", `attachment; filename="lingshu-home-bookmarks.html"`)
	return &Response{Status: 200, Body: out.Bytes(), ContentType: "text/html; charset=utf-8"}, nil
}
