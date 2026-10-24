ALTER TABLE settings ADD COLUMN language TEXT NOT NULL DEFAULT '' CHECK(language IN ('', 'zh-CN', 'en'));
