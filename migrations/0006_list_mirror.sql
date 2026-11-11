-- List messages delivered to a guest but not yet mirrored into that guest's
-- topic (src/mirror.js). Mirrored at once when the budget and Telegram's
-- per-group rate limit allow; otherwise when the guest next writes.
CREATE TABLE list_pending (
  user_id       INTEGER NOT NULL,
  list_msg_id   INTEGER NOT NULL, -- the admin's message in the list topic (first item of an album)
  list_topic_id INTEGER NOT NULL,
  guest_msg_id  INTEGER NOT NULL, -- the copy in the guest's chat (first item of an album)
  is_album      INTEGER NOT NULL DEFAULT 0,
  label         TEXT    NOT NULL, -- list name at send time
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_msg_id)
) WITHOUT ROWID;
