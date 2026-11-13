ALTER TABLE work_spaces ADD COLUMN status_revision BIGINT NOT NULL DEFAULT 1 CHECK(status_revision>=1);
ALTER TABLE work_spaces ADD COLUMN default_status TEXT NOT NULL DEFAULT 'todo';
CREATE TABLE work_statuses (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 status_type TEXT NOT NULL CHECK(status_type IN ('todo','doing','waiting','done','canceled')),
 color TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 sort_order INTEGER NOT NULL CHECK(sort_order>=0),
 retired BOOLEAN NOT NULL DEFAULT FALSE,
 replacement_id TEXT,
 PRIMARY KEY(space_id,id)
);
CREATE UNIQUE INDEX work_statuses_name ON work_statuses(space_id,name_key) WHERE retired=FALSE;
CREATE INDEX work_statuses_order ON work_statuses(space_id,retired,sort_order,id);
INSERT INTO work_spaces(space_id) SELECT id FROM spaces WHERE TRUE ON CONFLICT(space_id) DO NOTHING;
INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) SELECT id,'todo',CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'Todo' ELSE '待办' END,CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'todo' ELSE '待办' END,'todo','#8b9790',0 FROM spaces;
INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) SELECT id,'doing',CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'In progress' ELSE '进行中' END,CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'in progress' ELSE '进行中' END,'doing','#5596bc',1 FROM spaces;
INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) SELECT id,'waiting',CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'Waiting' ELSE '等待' END,CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'waiting' ELSE '等待' END,'waiting','#c99c35',2 FROM spaces;
INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) SELECT id,'done',CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'Done' ELSE '完成' END,CASE WHEN (SELECT language FROM settings WHERE id=1)='en' THEN 'done' ELSE '完成' END,'done','#50966a',3 FROM spaces;
CREATE TABLE work_items_014 (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 project_id TEXT REFERENCES work_projects(id) ON DELETE SET NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 next_step TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL,
 needs_attention BOOLEAN NOT NULL DEFAULT FALSE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 sort_order BIGINT NOT NULL CHECK(sort_order>=0),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL,
 create_hash_version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(space_id,status) REFERENCES work_statuses(space_id,id)
);
INSERT INTO work_items_014(id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) SELECT id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash FROM work_items;
CREATE TABLE work_item_links_014 AS SELECT * FROM work_item_links;
CREATE TABLE work_item_documents_014 AS SELECT * FROM work_item_documents;
DROP TABLE work_item_links;
DROP TABLE work_item_documents;
DROP TABLE work_items;
ALTER TABLE work_items_014 RENAME TO work_items;
CREATE INDEX work_items_column ON work_items(space_id,archived,status,sort_order,id);
CREATE INDEX work_items_attention ON work_items(space_id,archived,needs_attention,status,sort_order,id);
CREATE INDEX work_items_project_column ON work_items(space_id,project_id,archived,status,sort_order,id);
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
INSERT INTO work_item_links SELECT * FROM work_item_links_014;
INSERT INTO work_item_documents SELECT * FROM work_item_documents_014;
DROP TABLE work_item_links_014;
DROP TABLE work_item_documents_014;
