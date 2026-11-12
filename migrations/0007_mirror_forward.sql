-- 1 when the admin's list message was itself a forward (its mirror needs a label line).
ALTER TABLE list_pending ADD COLUMN fwd INTEGER NOT NULL DEFAULT 0;
