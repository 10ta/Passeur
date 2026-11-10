-- Guests who have messaged the bot. One forum topic per guest.
CREATE TABLE users (
  user_id         INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL DEFAULT '',
  username        TEXT,
  topic_id        INTEGER,
  verified        INTEGER NOT NULL DEFAULT 0,
  blocked         INTEGER NOT NULL DEFAULT 0,
  captcha_answer  INTEGER,
  captcha_fails   INTEGER NOT NULL DEFAULT 0,
  captcha_sent_at INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  pending_msg_id  INTEGER,
  notice_at       INTEGER NOT NULL DEFAULT 0, -- last rate-limit/locked notice (throttle)
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_topic ON users(topic_id) WHERE topic_id IS NOT NULL;

-- Message pairs for reply threading and edit sync.
-- dir 0: guest -> topic (guest_msg_id is the original, topic_msg_id the bot copy)
-- dir 1: topic -> guest (topic_msg_id is the admin's original, guest_msg_id the bot copy)
CREATE TABLE msg_map (
  guest_id     INTEGER NOT NULL,
  guest_msg_id INTEGER NOT NULL,
  topic_msg_id INTEGER NOT NULL,
  dir          INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (guest_id, guest_msg_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX msg_map_topic ON msg_map(topic_msg_id);

-- Album (media group) buffering. The first update of a group becomes the
-- sender; each item is "taken" exactly once (by the album send, or by a late
-- item that arrives after the album was sent and goes out on its own).
CREATE TABLE albums (
  album_key  TEXT    PRIMARY KEY,
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE album_items (
  album_key TEXT    NOT NULL,
  msg_id    INTEGER NOT NULL,
  taken     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album_key, msg_id)
) WITHOUT ROWID;

-- Broadcast jobs, advanced in batches by the cron trigger.
CREATE TABLE broadcasts (
  id          INTEGER PRIMARY KEY,
  src_msg_id  INTEGER NOT NULL,
  cursor      INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0, -- prevents cron and /broadcast from sending the same batch
  created_at  INTEGER NOT NULL
);
