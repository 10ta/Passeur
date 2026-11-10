-- List topics: outbound-only topics in the admin group. Anything an admin
-- posts there is copied to every member. Guest topics stay 1:1 (users.topic_id).
CREATE TABLE lists (
  topic_id   INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE list_members (
  topic_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  PRIMARY KEY (topic_id, user_id)
) WITHOUT ROWID;
