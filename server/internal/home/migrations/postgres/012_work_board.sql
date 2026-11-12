CREATE TABLE work_spaces (
 space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1)
);
CREATE TABLE work_projects (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL,
 UNIQUE(space_id,name_key)
);
CREATE INDEX work_projects_space ON work_projects(space_id,archived,name_key,id);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 project_id TEXT REFERENCES work_projects(id) ON DELETE SET NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 next_step TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('todo','doing','waiting','done')),
 needs_attention BOOLEAN NOT NULL DEFAULT FALSE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 sort_order BIGINT NOT NULL CHECK(sort_order>=0),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL
);
CREATE INDEX work_items_column ON work_items(space_id,archived,status,sort_order,id);
CREATE INDEX work_items_attention ON work_items(space_id,archived,needs_attention,status,sort_order,id);
CREATE INDEX work_items_project_column ON work_items(space_id,project_id,archived,status,sort_order,id);
CREATE INDEX work_items_list ON work_items(space_id,archived,(CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END),sort_order,id);
CREATE TABLE work_item_links (
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 PRIMARY KEY(item_id,link_id)
);
CREATE INDEX work_item_links_link ON work_item_links(link_id,item_id);
CREATE TABLE work_item_documents (
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 PRIMARY KEY(item_id,document_id)
);
CREATE INDEX work_item_documents_document ON work_item_documents(document_id,item_id);
