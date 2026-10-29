CREATE TABLE link_click_tracking (
 id INTEGER PRIMARY KEY CHECK(id=1),
 recorded_from TEXT NOT NULL
);
INSERT INTO link_click_tracking(id,recorded_from) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE link_click_totals (
 link_id TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 clicks INTEGER NOT NULL CHECK(clicks>=0),
 first_clicked_at TEXT NOT NULL,
 last_clicked_at TEXT NOT NULL
);
CREATE INDEX link_click_totals_space ON link_click_totals(space_id,clicks,link_id);
CREATE TABLE link_click_days (
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 day TEXT NOT NULL,
 entry TEXT NOT NULL CHECK(entry IN ('primary','internal','external','additional')),
 clicks INTEGER NOT NULL CHECK(clicks>=0),
 PRIMARY KEY(link_id,day,entry)
);
CREATE INDEX link_click_days_space_day ON link_click_days(space_id,day,link_id);
CREATE TABLE link_click_receipts (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 entry TEXT NOT NULL CHECK(entry IN ('primary','internal','external','additional')),
 received_at TEXT NOT NULL,
 PRIMARY KEY(space_id,event_id)
);
CREATE INDEX link_click_receipts_expiry ON link_click_receipts(received_at);
