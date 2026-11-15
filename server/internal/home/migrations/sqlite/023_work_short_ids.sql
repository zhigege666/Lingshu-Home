-- Replace card identity once; other resources retain their identifiers.
PRAGMA defer_foreign_keys=ON;

-- Only the migration owns this map; no legacy lookup survives the transaction.
CREATE TEMP TABLE work_item_id_map (
 old_id TEXT PRIMARY KEY,
 new_id TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL,
 old_number BIGINT NOT NULL,
 old_key TEXT NOT NULL,
 new_sort_order BIGINT NOT NULL
);
CREATE INDEX work_item_id_map_key ON work_item_id_map(space_id,old_key);
WITH RECURSIVE numbered AS (
 SELECT id,space_id,number,ROW_NUMBER() OVER(ORDER BY created_at,id) AS sequence,
  ROW_NUMBER() OVER(PARTITION BY space_id,archived,status ORDER BY sort_order,id)*1024 AS new_sort_order
 FROM work_items
), encoded(old_id,space_id,old_number,new_sort_order,remaining,digits) AS (
 SELECT id,space_id,number,new_sort_order,sequence,CAST('' AS TEXT) FROM numbered
 UNION ALL
 SELECT old_id,space_id,old_number,new_sort_order,remaining/36,
  substr('0123456789abcdefghijklmnopqrstuvwxyz',CAST(remaining%36+1 AS INTEGER),1)||digits
 FROM encoded WHERE remaining>0
)
INSERT INTO work_item_id_map(old_id,new_id,space_id,old_number,old_key,new_sort_order)
SELECT old_id,CASE WHEN length(digits)<5 THEN substr('00000',1,5-length(digits))||digits ELSE digits END,space_id,old_number,'W-'||CAST(old_number AS TEXT),new_sort_order
FROM encoded WHERE remaining=0;

CREATE TABLE work_item_sequence (
 id INTEGER PRIMARY KEY CHECK(id=1),
 next_number BIGINT NOT NULL CHECK(next_number>0)
);
INSERT INTO work_item_sequence(id,next_number) SELECT 1,COUNT(*)+1 FROM work_items;
ALTER TABLE work_items ADD COLUMN create_request_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN create_user_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX work_items_create_request ON work_items(space_id,create_user_id,create_request_id) WHERE create_request_id<>'';

UPDATE work_item_links AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_item_documents AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_activity AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_claims AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_collaboration_events AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_schedule_occurrences AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_item_labels AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_dependencies AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_dependencies AS target SET blocked_by_id=m.new_id FROM work_item_id_map AS m WHERE target.blocked_by_id=m.old_id;
UPDATE work_metric_intervals AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_automation_events AS target SET source_item_id=m.new_id FROM work_item_id_map AS m WHERE target.source_item_id=m.old_id;
UPDATE work_executions AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_automation_receipts AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;
UPDATE work_items AS target SET parent_id=m.new_id FROM work_item_id_map AS m WHERE target.parent_id=m.old_id;
UPDATE work_items AS target SET predecessor_id=m.new_id FROM work_item_id_map AS m WHERE target.predecessor_id=m.old_id;
UPDATE work_notices AS target SET item_id=m.new_id FROM work_item_id_map AS m WHERE target.item_id=m.old_id;

-- Activity stores only the relation fields as structural item references.
UPDATE work_activity AS a SET changes_json=(
 SELECT json_group_array(json(change)) FROM (
  SELECT CASE WHEN json_extract(j.value,'$.field')='relations' THEN CASE WHEN json_type(j.value,'$.after')='object' THEN json_set(CASE WHEN json_type(j.value,'$.before')='object' THEN json_set(j.value,'$.before',json((SELECT COALESCE(json_group_object(f.key,json(CASE
 WHEN f.key IN ('parentId','predecessorId') AND f.type='text'
 THEN json_quote(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=f.value),f.value))
 WHEN f.key='blockedByIds' AND f.type='array'
 THEN (SELECT json_group_array(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=b.value),b.value)) FROM json_each(f.value) AS b)
 ELSE CASE WHEN f.type IN ('object','array') THEN f.value ELSE json_quote(f.value) END END)),'{}')
 FROM json_each(json_extract(j.value,'$.before')) AS f))) ELSE j.value END,'$.after',json((SELECT COALESCE(json_group_object(f.key,json(CASE
 WHEN f.key IN ('parentId','predecessorId') AND f.type='text'
 THEN json_quote(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=f.value),f.value))
 WHEN f.key='blockedByIds' AND f.type='array'
 THEN (SELECT json_group_array(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=b.value),b.value)) FROM json_each(f.value) AS b)
 ELSE CASE WHEN f.type IN ('object','array') THEN f.value ELSE json_quote(f.value) END END)),'{}')
 FROM json_each(json_extract(j.value,'$.after')) AS f))) ELSE CASE WHEN json_type(j.value,'$.before')='object' THEN json_set(j.value,'$.before',json((SELECT COALESCE(json_group_object(f.key,json(CASE
 WHEN f.key IN ('parentId','predecessorId') AND f.type='text'
 THEN json_quote(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=f.value),f.value))
 WHEN f.key='blockedByIds' AND f.type='array'
 THEN (SELECT json_group_array(COALESCE((SELECT new_id FROM work_item_id_map WHERE old_id=b.value),b.value)) FROM json_each(f.value) AS b)
 ELSE CASE WHEN f.type IN ('object','array') THEN f.value ELSE json_quote(f.value) END END)),'{}')
 FROM json_each(json_extract(j.value,'$.before')) AS f))) ELSE j.value END END ELSE j.value END AS change
  FROM json_each(a.changes_json) AS j ORDER BY CAST(j.key AS INTEGER)
 )
) WHERE EXISTS(SELECT 1 FROM json_each(a.changes_json) AS j WHERE json_extract(j.value,'$.field')='relations');

UPDATE work_views AS v SET definition_json=json_set(definition_json,'$.filters.itemId',m.new_id),revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_id=json_extract(v.definition_json,'$.filters.itemId');

UPDATE work_views AS v SET definition_json=json_set(definition_json,'$.filters.itemId',m.new_id),revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_key=json_extract(v.definition_json,'$.filters.itemId') AND m.old_number>0;

UPDATE work_views AS v SET definition_json=json_set(definition_json,'$.filters.parentId',m.new_id),revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_id=json_extract(v.definition_json,'$.filters.parentId');

UPDATE work_views AS v SET definition_json=json_set(definition_json,'$.filters.parentId',m.new_id),revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_key=json_extract(v.definition_json,'$.filters.parentId') AND m.old_number>0;

UPDATE work_views AS v SET definition_json=json_set(definition_json,'$.fields',json((
 SELECT json_group_array(field) FROM (
  SELECT CASE WHEN value='key' THEN 'id' ELSE value END AS field,MIN(CAST(key AS INTEGER)) AS first_position
  FROM json_each(v.definition_json,'$.fields')
  GROUP BY CASE WHEN value='key' THEN 'id' ELSE value END ORDER BY first_position
 )
))),revision=revision+1
WHERE EXISTS(SELECT 1 FROM json_each(v.definition_json,'$.fields') WHERE value='key');

-- Receipt root IDs also identify sessions/events. Only card receipts have boardRevision.
UPDATE work_operation_receipts AS r SET response_json=json_set(response_json,'$.id',m.new_id)
FROM work_item_id_map AS m WHERE json_type(r.response_json,'$.boardRevision') IS NOT NULL AND json_extract(r.response_json,'$.id')=m.old_id;
UPDATE work_operation_receipts AS r SET response_json=json_set(response_json,'$.itemId',m.new_id)
FROM work_item_id_map AS m WHERE json_extract(r.response_json,'$.itemId')=m.old_id;

-- Already sent snapshots are immutable evidence. Only an undispatched queue entry changes.
UPDATE work_executions AS e SET snapshot_json=json_remove(json_set(snapshot_json,'$.item.id',m.new_id),'$.item.key')
FROM work_item_id_map AS m WHERE e.state='queued' AND json_extract(e.snapshot_json,'$.item.id')=m.old_id;

-- Preserve the old per-column order, including cards with equal ranks.
UPDATE work_items AS target SET id=m.new_id,sort_order=m.new_sort_order FROM work_item_id_map AS m WHERE target.id=m.old_id;
DROP INDEX work_items_number;
ALTER TABLE work_items DROP COLUMN number;
ALTER TABLE work_spaces DROP COLUMN next_number;
-- Existing board cursors must restart after the identifier namespace changes.
UPDATE work_spaces SET revision=revision+1,views_revision=views_revision+1;
UPDATE work_collaboration_spaces SET revision=revision+1;
DROP TABLE work_item_id_map;
