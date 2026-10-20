ALTER TABLE integration_sources DROP CONSTRAINT integration_sources_kind_check;
ALTER TABLE integration_sources ADD CONSTRAINT integration_sources_kind_check CHECK(kind IN ('external-push','github-traffic','calendar-ics','weather-open-meteo','external-json'));
ALTER TABLE integration_receipts ADD COLUMN received_at TEXT NOT NULL DEFAULT '';
UPDATE integration_receipts SET received_at=COALESCE(receipt_json->>'receivedAt','');
CREATE INDEX integration_receipts_retention ON integration_receipts(source_id,received_at,request_id);
CREATE INDEX integration_sources_due ON integration_sources(enabled,next_sync_at);
