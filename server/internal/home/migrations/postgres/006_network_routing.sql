ALTER TABLE settings ADD COLUMN auto_select_endpoint BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE network_proxy_config (
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
 mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','proxy')),
 url TEXT NOT NULL DEFAULT '',
 credential_cipher TEXT NULL
);
INSERT INTO network_proxy_config(id) VALUES(1);
