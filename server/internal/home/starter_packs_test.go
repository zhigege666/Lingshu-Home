package home

import (
	"strings"
	"testing"
)

func TestStarterPacksAreDistinctStaticContent(t *testing.T) {
	sets := map[string]map[string]bool{}
	for _, id := range []string{"zh-CN", "en"} {
		pack, err := starterPack(id)
		if err != nil || len(pack.Groups) != 3 || pack.Version == "" {
			t.Fatalf("invalid starter pack: %v", err)
		}
		urls := map[string]bool{}
		for _, group := range pack.Groups {
			for _, link := range group.Links {
				canonical, err := canonicalURL(link.URL)
				if err != nil || canonical != link.URL || urls[link.URL] || !strings.HasPrefix(link.Icon, "lucide:") {
					t.Fatalf("invalid or duplicate starter link: %#v %v", link, err)
				}
				urls[link.URL] = true
			}
		}
		if len(urls) != 12 {
			t.Fatalf("expected 12 deliberately selected links, got %d", len(urls))
		}
		sets[id] = urls
	}
	if !sets["zh-CN"]["https://developer.mozilla.org/zh-CN/"] || !sets["en"]["https://developer.mozilla.org/en-US/"] ||
		!sets["zh-CN"]["https://www.baidu.com/"] || sets["en"]["https://www.baidu.com/"] {
		t.Fatal("content packs only relabel the same websites")
	}
}

func TestStarterPackChoiceDoesNotChangeInterfaceLanguage(t *testing.T) {
	for _, seed := range []bool{true, false} {
		config := coreConfig(t, false)
		config.Language = "en"
		app, err := Open(config)
		if err != nil {
			t.Fatal(err)
		}
		browser := newAppTestBrowser(t, app)
		browser.bootstrap()
		input := map[string]any{"siteName": "My Home", "mode": ModeOpenEdit, "seedDemo": seed, "starterPack": "unsupported"}
		if status, _ := browser.call("POST", "/setup", input); status != 400 {
			t.Fatalf("unknown pack accepted: %d", status)
		}
		if browser.bootstrap()["initialized"] != false {
			t.Fatal("invalid pack partially initialized the instance")
		}
		input["starterPack"] = "zh-CN"
		browser.ok("POST", "/setup", input)
		bootstrap := browser.bootstrap()
		if bootstrap["language"] != "en" {
			t.Fatal("content pack changed the interface language")
		}
		space := coreSpace(bootstrap, "shared")
		data := browser.ok("GET", "/spaces/"+space+"/navigation", nil)["data"].(map[string]any)
		links := data["links"].([]any)
		if seed {
			if len(links) != 12 {
				t.Fatalf("wrong seeded count: %d", len(links))
			}
			found := false
			for _, value := range links {
				link := value.(map[string]any)
				if link["title"] == "百度" && link["url"] == "https://www.baidu.com/" {
					found = true
				}
			}
			if !found {
				t.Fatal("chosen Chinese content pack was not used")
			}
		} else if len(links) != 0 {
			t.Fatal("blank setup created starter content")
		}
		if err := app.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
