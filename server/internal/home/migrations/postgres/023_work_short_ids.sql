-- Replace card identity in the migration transaction, preserving all foreign keys.
ALTER TABLE work_item_links ALTER CONSTRAINT work_item_links_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_item_documents ALTER CONSTRAINT work_item_documents_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_activity ALTER CONSTRAINT work_activity_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_claims ALTER CONSTRAINT work_claims_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_collaboration_events ALTER CONSTRAINT work_collaboration_events_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_schedule_occurrences ALTER CONSTRAINT work_schedule_occurrences_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_item_labels ALTER CONSTRAINT work_item_labels_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_dependencies ALTER CONSTRAINT work_dependencies_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_dependencies ALTER CONSTRAINT work_dependencies_blocked_by_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_metric_intervals ALTER CONSTRAINT work_metric_intervals_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_automation_events ALTER CONSTRAINT work_automation_events_source_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_executions ALTER CONSTRAINT work_executions_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_automation_receipts ALTER CONSTRAINT work_automation_receipts_item_id_fkey DEFERRABLE INITIALLY DEFERRED;
SET CONSTRAINTS ALL DEFERRED;

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

UPDATE work_activity AS a SET changes_json=(
 SELECT jsonb_agg(CASE WHEN j.value->>'field'='relations' THEN CASE WHEN jsonb_typeof(j.value->'after')='object' THEN jsonb_set(CASE WHEN jsonb_typeof(j.value->'before')='object' THEN jsonb_set(j.value,'{before}',(SELECT COALESCE(jsonb_object_agg(f.key,CASE
 WHEN f.key IN ('parentId','predecessorId') AND jsonb_typeof(f.value)='string'
 THEN COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=f.value#>>'{}'),f.value)
 WHEN f.key='blockedByIds' AND jsonb_typeof(f.value)='array'
 THEN (SELECT COALESCE(jsonb_agg(COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=b.value#>>'{}'),b.value) ORDER BY b.position),'[]'::jsonb) FROM jsonb_array_elements(f.value) WITH ORDINALITY AS b(value,position))
 ELSE f.value END),'{}'::jsonb) FROM jsonb_each(j.value->'before') AS f),false) ELSE j.value END,'{after}',(SELECT COALESCE(jsonb_object_agg(f.key,CASE
 WHEN f.key IN ('parentId','predecessorId') AND jsonb_typeof(f.value)='string'
 THEN COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=f.value#>>'{}'),f.value)
 WHEN f.key='blockedByIds' AND jsonb_typeof(f.value)='array'
 THEN (SELECT COALESCE(jsonb_agg(COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=b.value#>>'{}'),b.value) ORDER BY b.position),'[]'::jsonb) FROM jsonb_array_elements(f.value) WITH ORDINALITY AS b(value,position))
 ELSE f.value END),'{}'::jsonb) FROM jsonb_each(j.value->'after') AS f),false) ELSE CASE WHEN jsonb_typeof(j.value->'before')='object' THEN jsonb_set(j.value,'{before}',(SELECT COALESCE(jsonb_object_agg(f.key,CASE
 WHEN f.key IN ('parentId','predecessorId') AND jsonb_typeof(f.value)='string'
 THEN COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=f.value#>>'{}'),f.value)
 WHEN f.key='blockedByIds' AND jsonb_typeof(f.value)='array'
 THEN (SELECT COALESCE(jsonb_agg(COALESCE((SELECT to_jsonb(new_id) FROM work_item_id_map WHERE old_id=b.value#>>'{}'),b.value) ORDER BY b.position),'[]'::jsonb) FROM jsonb_array_elements(f.value) WITH ORDINALITY AS b(value,position))
 ELSE f.value END),'{}'::jsonb) FROM jsonb_each(j.value->'before') AS f),false) ELSE j.value END END ELSE j.value END ORDER BY j.position)::text
 FROM jsonb_array_elements(a.changes_json::jsonb) WITH ORDINALITY AS j(value,position)
) WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(a.changes_json::jsonb) AS j(value) WHERE j.value->>'field'='relations');

UPDATE work_views AS v SET definition_json=jsonb_set(definition_json::jsonb,'{filters,itemId}',to_jsonb(m.new_id),false)::text,revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_id=v.definition_json::jsonb#>>'{filters,itemId}';

UPDATE work_views AS v SET definition_json=jsonb_set(definition_json::jsonb,'{filters,itemId}',to_jsonb(m.new_id),false)::text,revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_key=v.definition_json::jsonb#>>'{filters,itemId}' AND m.old_number>0;

UPDATE work_views AS v SET definition_json=jsonb_set(definition_json::jsonb,'{filters,parentId}',to_jsonb(m.new_id),false)::text,revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_id=v.definition_json::jsonb#>>'{filters,parentId}';

UPDATE work_views AS v SET definition_json=jsonb_set(definition_json::jsonb,'{filters,parentId}',to_jsonb(m.new_id),false)::text,revision=revision+1
FROM work_item_id_map AS m
WHERE m.space_id=v.space_id AND m.old_key=v.definition_json::jsonb#>>'{filters,parentId}' AND m.old_number>0;

UPDATE work_views AS v SET definition_json=jsonb_set(definition_json::jsonb,'{fields}',(
 SELECT COALESCE(jsonb_agg(to_jsonb(field) ORDER BY first_position),'[]'::jsonb) FROM (
  SELECT CASE WHEN value='key' THEN 'id' ELSE value END AS field,MIN(position) AS first_position
  FROM jsonb_array_elements_text(v.definition_json::jsonb->'fields') WITH ORDINALITY AS f(value,position)
  GROUP BY CASE WHEN value='key' THEN 'id' ELSE value END
 ) AS fields
),false)::text,revision=revision+1
WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.definition_json::jsonb->'fields') AS f(value) WHERE value='key');

UPDATE work_operation_receipts AS r SET response_json=jsonb_set(response_json::jsonb,'{id}',to_jsonb(m.new_id),false)::text
FROM work_item_id_map AS m WHERE r.response_json::jsonb ? 'boardRevision' AND r.response_json::jsonb->>'id'=m.old_id;
UPDATE work_operation_receipts AS r SET response_json=jsonb_set(response_json::jsonb,'{itemId}',to_jsonb(m.new_id),false)::text
FROM work_item_id_map AS m WHERE r.response_json::jsonb->>'itemId'=m.old_id;

-- Already sent snapshots retain the exact bytes used for the external request.
UPDATE work_executions AS e SET snapshot_json=(jsonb_set(snapshot_json::jsonb,'{item,id}',to_jsonb(m.new_id),false)#-'{item,key}')::text
FROM work_item_id_map AS m WHERE e.state='queued' AND e.snapshot_json::jsonb#>>'{item,id}'=m.old_id;

-- Preserve the old per-column order, including cards with equal ranks.
UPDATE work_items AS target SET id=m.new_id,sort_order=m.new_sort_order FROM work_item_id_map AS m WHERE target.id=m.old_id;
-- Flush deferred FK checks before ALTER TABLE; pending trigger events forbid DDL.
SET CONSTRAINTS ALL IMMEDIATE;
DROP INDEX work_items_number;
ALTER TABLE work_items DROP COLUMN number;
ALTER TABLE work_spaces DROP COLUMN next_number;
-- Existing board cursors must restart after the identifier namespace changes.
UPDATE work_spaces SET revision=revision+1,views_revision=views_revision+1;
UPDATE work_collaboration_spaces SET revision=revision+1;
DROP TABLE work_item_id_map;
ALTER TABLE work_item_links ALTER CONSTRAINT work_item_links_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_item_documents ALTER CONSTRAINT work_item_documents_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_activity ALTER CONSTRAINT work_activity_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_claims ALTER CONSTRAINT work_claims_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_collaboration_events ALTER CONSTRAINT work_collaboration_events_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_schedule_occurrences ALTER CONSTRAINT work_schedule_occurrences_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_item_labels ALTER CONSTRAINT work_item_labels_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_dependencies ALTER CONSTRAINT work_dependencies_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_dependencies ALTER CONSTRAINT work_dependencies_blocked_by_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_metric_intervals ALTER CONSTRAINT work_metric_intervals_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_automation_events ALTER CONSTRAINT work_automation_events_source_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_executions ALTER CONSTRAINT work_executions_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE work_automation_receipts ALTER CONSTRAINT work_automation_receipts_item_id_fkey NOT DEFERRABLE INITIALLY IMMEDIATE;
