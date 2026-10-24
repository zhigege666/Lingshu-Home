package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestFirstRunLanguageSelectionAndPersistence(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, language := range []string{"zh-CN", "en"} {
			t.Run(fmt.Sprintf("postgres-%v/%s", postgres, language), func(t *testing.T) {
				config := autoIconConfig(t, postgres)
				config.Language = ""
				app, err := Open(config)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if app != nil {
						_ = app.Close()
					}
				})
				browser := newAppTestBrowser(t, app)
				boot := browser.bootstrap()
				if boot["languageSelectionRequired"] != true || boot["initialized"] != false {
					t.Fatalf("unspecified language did not require first-run selection: %v", boot)
				}
				if packs := readInstanceStarterPacks(t, browser); len(packs) != 0 {
					t.Fatal("starter collection available before language was selected")
				}
				setup := map[string]any{"siteName": "My Home", "mode": ModeOpenEdit, "seedDemo": true}
				if status, body := browser.call("POST", "/setup", setup); status != 409 || body["code"] != "language_required" {
					t.Fatalf("setup bypassed language choice: %d %v", status, body)
				}
				if status, _ := browser.call("POST", "/setup/language", map[string]any{"language": "fr"}); status != 400 {
					t.Fatal("unsupported language accepted")
				}
				csrf := browser.csrf
				browser.csrf = ""
				if status, _ := browser.call("POST", "/setup/language", map[string]any{"language": language}); status != 403 {
					t.Fatal("language selection did not require CSRF")
				}
				browser.csrf = csrf
				selected := browser.ok("POST", "/setup/language", map[string]any{"language": language})
				if selected["language"] != language || selected["languageSelectionRequired"] != false || selected["initialized"] != false {
					t.Fatalf("language selection returned incorrect bootstrap: %v", selected)
				}
				other := "en"
				if language == "en" {
					other = "zh-CN"
				}
				browser.ok("POST", "/setup/language", map[string]any{"language": language})
				if status, body := browser.call("POST", "/setup/language", map[string]any{"language": other}); status != 409 || body["code"] != "language_locked" {
					t.Fatalf("second language choice was not locked: %d %v", status, body)
				}
				packs := readInstanceStarterPacks(t, browser)
				if len(packs) != 1 || packs[0].ID != language {
					t.Fatal("starter collection does not follow selected instance language")
				}
				if err = app.Close(); err != nil {
					t.Fatal(err)
				}
				app = nil
				app, err = Open(config)
				if err != nil {
					t.Fatal(err)
				}
				browser.client.Transport = appTestTransport{app}
				boot = browser.bootstrap()
				if boot["language"] != language || boot["languageSelectionRequired"] != false || app.currentLanguage() != language {
					t.Fatal("restart lost the choice made before setup")
				}
				browser.ok("POST", "/setup", setup)
				boot = browser.bootstrap()
				shared := coreSpace(boot, "shared")
				before := browser.ok("GET", "/spaces/"+shared+"/navigation", nil)
				if len(before["data"].(map[string]any)["links"].([]any)) != 12 {
					t.Fatal("fixed collection was not seeded")
				}
				storedBefore := map[string]componentMigrationRows{}
				for _, table := range []string{"settings", "spaces", "pages", "categories", "links"} {
					storedBefore[table] = componentCaptureRows(t, app.store.DB, table, nil)
				}
				browser.ok("POST", "/setup/language", map[string]any{"language": language})
				if status, _ := browser.call("POST", "/setup/language", map[string]any{"language": other}); status != 409 {
					t.Fatal("initialized instance allowed a language change")
				}
				if err = app.Close(); err != nil {
					t.Fatal(err)
				}
				app = nil
				config.Language = other
				app, err = Open(config)
				if err != nil {
					t.Fatalf("conflicting startup configuration must preserve availability: %v", err)
				}
				browser.client.Transport = appTestTransport{app}
				boot = browser.bootstrap()
				if boot["language"] != language || boot["languageSelectionRequired"] != false || app.currentLanguage() != language {
					t.Fatal("new startup value replaced the fixed language")
				}
				after := browser.ok("GET", "/spaces/"+shared+"/navigation", nil)
				assertLanguageRestartNavigation(t, before, after)
				for table, want := range storedBefore {
					if got := componentCaptureRows(t, app.store.DB, table, want.columns); !reflect.DeepEqual(want, got) {
						t.Fatalf("language restart changed persisted %s rows", table)
					}
				}
			})
		}
	}
}

func assertLanguageRestartNavigation(t *testing.T, before, after map[string]any) {
	t.Helper()
	// localDataset builds receivedAt/lastSuccessAt from time.Now on every read;
	// neither is stored navigation state. Check their time contract separately,
	// then compare every other envelope/data/meta field without normalization.
	snapshots := make([]map[string]any, 0, 2)
	var previousRead time.Time
	for _, value := range []map[string]any{before, after} {
		meta := value["meta"].(map[string]any)
		received, ok := meta["receivedAt"].(string)
		if !ok || meta["lastSuccessAt"] != received {
			t.Fatal("local dataset read timestamps must describe the same successful read")
		}
		readTime, err := time.Parse(time.RFC3339Nano, received)
		if err != nil || readTime.IsZero() || (!previousRead.IsZero() && readTime.Before(previousRead)) {
			t.Fatal("local dataset returned an invalid or regressing read timestamp")
		}
		previousRead = readTime
		stableMeta := make(map[string]any, len(meta)-2)
		for key, field := range meta {
			if key != "receivedAt" && key != "lastSuccessAt" {
				stableMeta[key] = field
			}
		}
		stable := make(map[string]any, len(value))
		for key, field := range value {
			stable[key] = field
		}
		stable["meta"] = stableMeta
		snapshots = append(snapshots, stable)
	}
	if !reflect.DeepEqual(snapshots[0], snapshots[1]) {
		t.Fatal("language restart changed navigation data, revision or stable dataset metadata")
	}
}

func readInstanceStarterPacks(t *testing.T, browser *coreBrowser) []StarterPack {
	t.Helper()
	response, err := browser.client.Get(browser.base + "/api/v1/starter-packs")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var packs []StarterPack
	if response.StatusCode != http.StatusOK {
		t.Fatalf("starter preview returned %d", response.StatusCode)
	}
	if err = json.NewDecoder(response.Body).Decode(&packs); err != nil {
		t.Fatal(err)
	}
	return packs
}

func TestFirstRunLanguageSelectionConcurrentRequests(t *testing.T) {
	config := coreConfig(t, false)
	config.Language = ""
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	first, second := newAppTestBrowser(t, app), newAppTestBrowser(t, app)
	first.bootstrap()
	second.bootstrap()
	start := make(chan struct{})
	statuses := make([]int, 2)
	bodies := make([]map[string]any, 2)
	var workers sync.WaitGroup
	for i, browser := range []*coreBrowser{first, second} {
		workers.Add(1)
		go func(i int, browser *coreBrowser) {
			defer workers.Done()
			<-start
			statuses[i], bodies[i] = browser.call("POST", "/setup/language", map[string]any{"language": []string{"zh-CN", "en"}[i]})
		}(i, browser)
	}
	close(start)
	// Read snapshots while the first selection is committing. Each response's
	// header must agree with its own bootstrap, even if another request wins.
	for i := 0; i < 10; i++ {
		response, err := first.client.Get(first.base + "/api/v1/bootstrap")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		var boot map[string]any
		if err = json.Unmarshal(body, &boot); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 || response.Header.Get("Content-Language") != boot["language"] {
			t.Fatalf("concurrent bootstrap language/header mismatch: %s %s", response.Header.Get("Content-Language"), body)
		}
	}
	workers.Wait()
	if !((statuses[0] == 200 && statuses[1] == 409) || (statuses[0] == 409 && statuses[1] == 200)) {
		t.Fatalf("concurrent choices did not produce one winner: %v %v", statuses, bodies)
	}
	winner := "zh-CN"
	if statuses[1] == 200 {
		winner = "en"
	}
	if boot := first.bootstrap(); boot["language"] != winner || boot["languageSelectionRequired"] != false || app.currentLanguage() != winner {
		t.Fatal("concurrent choices did not leave a single persisted runtime language")
	}
}

func TestFirstRunLanguageRollbackDoesNotChangeRuntime(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			config := autoIconConfig(t, postgres)
			config.Language = ""
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			browser := newAppTestBrowser(t, app)
			browser.bootstrap()
			// Make only COMMIT fail, after the handler has completed its update
			// and assembled a successful bootstrap. This verifies the real router.
			if _, err = app.store.DB.Exec("CREATE TABLE language_commit_guard (id INTEGER REFERENCES settings(id) DEFERRABLE INITIALLY DEFERRED)"); err != nil {
				t.Fatal(err)
			}
			if postgres {
				if _, err = app.store.DB.Exec("CREATE FUNCTION fail_language_commit() RETURNS TRIGGER AS $$ BEGIN INSERT INTO language_commit_guard(id) VALUES(2); RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER fail_language_commit AFTER UPDATE OF language ON settings FOR EACH ROW EXECUTE FUNCTION fail_language_commit();"); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err = app.store.DB.Exec("CREATE TRIGGER fail_language_commit AFTER UPDATE OF language ON settings BEGIN INSERT INTO language_commit_guard(id) VALUES(2); END;"); err != nil {
					t.Fatal(err)
				}
			}
			if status, _ := browser.call("POST", "/setup/language", map[string]any{"language": "en"}); status != 500 {
				t.Fatalf("injected language commit failure returned %d", status)
			}
			if boot := browser.bootstrap(); boot["languageSelectionRequired"] != true || boot["language"] != "zh-CN" || app.currentLanguage() != "zh-CN" {
				t.Fatalf("failed commit leaked a language choice: %v", boot)
			}
		})
	}
}

func TestLegacyInstanceLanguageIsAdoptedWithoutSetup(t *testing.T) {
	for _, startup := range []string{"", "en"} {
		t.Run("startup-"+startup, func(t *testing.T) {
			config := coreConfig(t, false)
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if app != nil {
					_ = app.Close()
				}
			})
			browser := newAppTestBrowser(t, app)
			browser.bootstrap()
			browser.ok("POST", "/setup", map[string]any{"siteName": "Existing Home", "mode": ModeOpenEdit, "seedDemo": false})
			before := browser.bootstrap()
			// A new migration leaves language empty on an initialized old database.
			if _, err = app.store.DB.Exec("UPDATE settings SET language='' WHERE id=1"); err != nil {
				t.Fatal(err)
			}
			if err = app.Close(); err != nil {
				t.Fatal(err)
			}
			app = nil
			config.Language = startup
			app, err = Open(config)
			if err != nil {
				t.Fatal(err)
			}
			browser.client.Transport = appTestTransport{app}
			after := browser.bootstrap()
			want := startup
			if want == "" {
				want = "zh-CN"
			}
			if after["language"] != want || after["languageSelectionRequired"] != false || after["initialized"] != true || after["siteName"] != before["siteName"] || !reflect.DeepEqual(before["spaces"], after["spaces"]) {
				t.Fatalf("legacy upgrade changed data or reopened setup: %v", after)
			}
		})
	}
}

func TestInstanceLanguageMigrationPreservesRowsAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				config := autoIconConfig(t, postgres)
				provider, driver, dsn := "sqlite", "sqlite", "file:"+filepath.Join(t.TempDir(), "legacy.db")+"?_pragma=foreign_keys(1)"
				if postgres {
					provider, driver, dsn = "postgres", "pgx", config.DatabaseURL
				}
				db, err := sql.Open(driver, dsn)
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				db.SetMaxOpenConns(1)
				store := &Store{DB: db, Provider: provider}
				for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql", "005_auto_icons.sql", "006_network_routing.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec(string(body)); err != nil {
						t.Fatal(err)
					}
				}
				if _, err = db.Exec(store.Query("UPDATE settings SET initialized=?,site_name=?,mode=?,auth_epoch=?,auto_fetch_icons=?"), true, "Existing instance", ModePrivateMulti, 19, false); err != nil {
					t.Fatal(err)
				}
				before := componentCaptureRows(t, db, "settings", nil)
				body, err := migrationFiles.ReadFile("migrations/" + provider + "/007_instance_language.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT force_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						t.Fatal("injected migration failure did not fail")
					}
					_ = tx.Rollback()
				} else {
					if err != nil {
						_ = tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				if after := componentCaptureRows(t, db, "settings", before.columns); !reflect.DeepEqual(before, after) {
					t.Fatal("language migration changed existing settings")
				}
				var language string
				err = db.QueryRow("SELECT language FROM settings WHERE id=1").Scan(&language)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back language column remains")
					}
					return
				}
				if err != nil || language != "" {
					t.Fatal("migration did not leave an undecided language")
				}
				if _, err = db.Exec("UPDATE settings SET language='fr' WHERE id=1"); err == nil {
					t.Fatal("language constraint accepted an unsupported locale")
				}
			})
		}
	}
}
