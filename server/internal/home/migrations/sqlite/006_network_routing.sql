ALTER TABLE settings ADD COLUMN auto_select_endpoint INTEGER NOT NULL DEFAULT 1 CHECK(auto_select_endpoint IN (0,1));
CREATE TABLE network_proxy_config (
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
 mode TEXT NOT NULL DEFAULT 'direct' CHECK(mode IN ('direct','proxy')),
 url TEXT NOT NULL DEFAULT '',
 credential_cipher TEXT NULL
);
INSERT INTO network_proxy_config(id) VALUES(1);
