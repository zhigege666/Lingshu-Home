ALTER TABLE settings ADD COLUMN auto_fetch_icons INTEGER NOT NULL DEFAULT 1 CHECK(auto_fetch_icons IN (0,1));
ALTER TABLE links ADD COLUMN icon_mode TEXT NOT NULL DEFAULT 'manual' CHECK(icon_mode IN ('auto','manual'));
ALTER TABLE links ADD COLUMN icon_origin TEXT NOT NULL DEFAULT '';
CREATE INDEX links_auto_icon_origin ON links(space_id,icon_mode,icon_origin);
CREATE TABLE icon_favicon_jobs (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 id TEXT NOT NULL UNIQUE,
 auth_epoch INTEGER NOT NULL,
 actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 actor_user_version INTEGER NOT NULL,
 token_hash TEXT NOT NULL DEFAULT '',
 requested_at TEXT NOT NULL,
 PRIMARY KEY(space_id,origin)
);
CREATE INDEX icon_favicon_jobs_pending ON icon_favicon_jobs(requested_at,id);
