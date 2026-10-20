CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 initialized BOOLEAN NOT NULL DEFAULT FALSE,
 site_name TEXT NOT NULL DEFAULT 'Lingshu-Home',
 mode TEXT NOT NULL DEFAULT 'public_read' CHECK(mode IN ('open_edit','public_read','private_single','private_multi')),
 registration_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 auth_epoch BIGINT NOT NULL DEFAULT 1
);
INSERT INTO settings(id) VALUES(1);
CREATE TABLE users (
 id TEXT PRIMARY KEY,
 username TEXT NOT NULL,
 normalized_username TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('Owner','Member')),
 is_enabled BOOLEAN NOT NULL,
 password_hash TEXT NOT NULL,
 version BIGINT NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX one_owner ON users(role) WHERE role = 'Owner';
CREATE TABLE spaces (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('shared','personal')),
 owner_user_id TEXT REFERENCES users(id),
 published BOOLEAN NOT NULL,
 data_revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL,
 CHECK((kind='shared' AND owner_user_id IS NULL) OR (kind='personal' AND owner_user_id IS NOT NULL AND NOT published))
);
CREATE UNIQUE INDEX one_shared_space ON spaces(kind) WHERE kind='shared';
CREATE UNIQUE INDEX one_personal_space ON spaces(owner_user_id) WHERE kind='personal';
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 auth_epoch BIGINT NOT NULL,
 user_version BIGINT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE categories (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES categories(id),
 name TEXT NOT NULL,
 icon TEXT NOT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX categories_space ON categories(space_id,sort_order,id);
CREATE TABLE links (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 category_id TEXT REFERENCES categories(id),
 title TEXT NOT NULL,
 url TEXT NOT NULL,
 canonical_url TEXT NOT NULL,
 description TEXT NOT NULL,
 icon TEXT NOT NULL,
 tags JSONB NOT NULL,
 is_favorite BOOLEAN NOT NULL,
 sort_order INTEGER NOT NULL DEFAULT 0,
 endpoints JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX links_space ON links(space_id,sort_order,id);
CREATE INDEX links_canonical ON links(space_id,md5(canonical_url));
CREATE TABLE pages (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1,
 config JSONB NOT NULL
);
