-- All message ids of a list album (comma-separated), so its mirror can be a
-- real forwarded album instead of a label line. NULL for single messages.
ALTER TABLE list_pending ADD COLUMN msg_ids TEXT;
