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
ALTER TABLE work_items DROP CONSTRAINT work_items_status_check;
ALTER TABLE work_items ADD COLUMN create_hash_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE work_items ADD CONSTRAINT work_items_status_ref FOREIGN KEY(space_id,status) REFERENCES work_statuses(space_id,id);
DROP INDEX work_items_list;
