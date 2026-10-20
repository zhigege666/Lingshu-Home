package home

type StarterLink struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
}
type StarterGroup struct {
	Name  string        `json:"name"`
	Icon  string        `json:"icon"`
	Links []StarterLink `json:"links"`
}
type StarterPack struct {
	ID      string         `json:"id"`
	Version string         `json:"version"`
	Name    string         `json:"name"`
	Groups  []StarterGroup `json:"groups"`
}

// Content language is independent of interface language. These are static
// examples, never a reason to start health checks, icon fetches or telemetry.
func starterPack(id string) (StarterPack, error) {
	pack := StarterPack{ID: id, Version: "1.0.0"}
	switch id {
	case "zh-CN":
		pack.Name = "中文常用"
		pack.Groups = []StarterGroup{
			{"开发工具", "lucide:code-xml", []StarterLink{
				{"GitHub", "https://github.com/", "项目与源代码", "lucide:code-xml"},
				{"Gitee", "https://gitee.com/", "代码托管与开源项目", "lucide:code-xml"},
				{"Go 文档", "https://go.dev/doc/", "Go 语言官方文档", "lucide:book-open"},
				{"MDN 中文", "https://developer.mozilla.org/zh-CN/", "Web 平台中文文档", "lucide:book-open"},
				{"React 中文", "https://zh-hans.react.dev/", "React 官方中文文档", "lucide:book-open"},
				{"Vue 中文", "https://cn.vuejs.org/", "Vue 官方中文文档", "lucide:book-open"},
			}},
			{"日常与阅读", "lucide:globe", []StarterLink{
				{"百度", "https://www.baidu.com/", "搜索网页与资料", "lucide:globe"},
				{"哔哩哔哩", "https://www.bilibili.com/", "视频与学习内容", "lucide:bookmark"},
				{"知乎", "https://www.zhihu.com/", "问题、经验与讨论", "lucide:book-open"},
			}},
			{"设计与工具", "lucide:compass", []StarterLink{
				{"Iconfont", "https://www.iconfont.cn/", "查找图标；使用前核对素材许可", "lucide:compass"},
				{"即时设计", "https://js.design/", "在线界面设计与协作", "lucide:compass"},
				{"Excalidraw", "https://excalidraw.com/", "手绘风格图示与白板", "lucide:bookmark"},
			}},
		}
	case "en":
		pack.Name = "English essentials"
		pack.Groups = []StarterGroup{
			{"Build & develop", "lucide:code-xml", []StarterLink{
				{"GitHub", "https://github.com/", "Projects and source code", "lucide:code-xml"},
				{"GitLab", "https://gitlab.com/", "Code hosting and collaboration", "lucide:code-xml"},
				{"Go documentation", "https://go.dev/doc/", "Official Go documentation", "lucide:book-open"},
				{"MDN Web Docs", "https://developer.mozilla.org/en-US/", "Web platform documentation", "lucide:book-open"},
				{"React", "https://react.dev/", "Official React documentation", "lucide:book-open"},
				{"Vue", "https://vuejs.org/", "Official Vue documentation", "lucide:book-open"},
			}},
			{"Everyday & reading", "lucide:globe", []StarterLink{
				{"Google", "https://www.google.com/", "Search the web", "lucide:globe"},
				{"YouTube", "https://www.youtube.com/", "Videos and learning", "lucide:bookmark"},
				{"Wikipedia", "https://www.wikipedia.org/", "A free encyclopedia", "lucide:book-open"},
			}},
			{"Design & tools", "lucide:compass", []StarterLink{
				{"Tabler Icons", "https://tabler.io/icons", "Open source interface icons", "lucide:compass"},
				{"Figma", "https://www.figma.com/", "Interface design and collaboration", "lucide:compass"},
				{"Excalidraw", "https://excalidraw.com/", "Hand-drawn diagrams and whiteboards", "lucide:bookmark"},
			}},
		}
	default:
		return pack, invalid("Unknown starter content pack. Choose zh-CN or en.")
	}
	return pack, nil
}

func (a *App) listStarterPacks(r *Request) (*Response, error) {
	chinese, _ := starterPack("zh-CN")
	english, _ := starterPack("en")
	return ok([]StarterPack{chinese, english}), nil
}

func (a *App) seedDemo(r *Request, spaceID string) error {
	return a.seedStarterPack(r, spaceID, "")
}

func (a *App) seedStarterPack(r *Request, spaceID, packID string) error {
	if packID == "" {
		packID = a.config.Language
		if packID == "" {
			packID = "zh-CN"
		}
	}
	pack, err := starterPack(packID)
	if err != nil {
		return err
	}
	for i, group := range pack.Groups {
		id := newID()
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,?,?,?,?)"), id, spaceID, nil, group.Name, group.Icon, i); err != nil {
			return err
		}
		for j, item := range group.Links {
			if _, err := a.insertLink(r, spaceID, linkInput{CategoryID: &id, Title: item.Title, URL: item.URL, Description: item.Description, Icon: item.Icon, Tags: []string{}, Endpoints: []Endpoint{}, IsFavorite: j == 0, SortOrder: j}); err != nil {
				return err
			}
		}
	}
	return a.touchNavigation(r, spaceID)
}
