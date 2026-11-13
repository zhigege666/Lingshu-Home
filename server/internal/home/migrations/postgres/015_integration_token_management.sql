ALTER TABLE integration_tokens ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>=1);
ALTER TABLE integration_tokens ADD COLUMN never_expires BOOLEAN NOT NULL DEFAULT FALSE CHECK(never_expires IN (FALSE,TRUE));
ALTER TABLE integration_tokens ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'selected' CHECK(permission_mode IN ('selected','all'));
