-- Settings changed from the /settings panel. scope = 'g' (global) or 't:<topic_id>'.
-- Resolution: topic row -> global row -> .env -> built-in default (src/settings.js).
CREATE TABLE settings (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
