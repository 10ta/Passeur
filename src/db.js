// All D1 access lives here. Every per-message lookup hits a primary key or an
// index, so rows_read stays proportional to rows returned.

export const DIR_IN = 0; // guest -> topic
export const DIR_OUT = 1; // topic -> guest

export const now = () => Math.floor(Date.now() / 1000);

export function createDb(d1) {
  const one = (sql, ...args) => d1.prepare(sql).bind(...args).first();
  const run = (sql, ...args) => d1.prepare(sql).bind(...args).run();
  const all = async (sql, ...args) => (await d1.prepare(sql).bind(...args).all()).results ?? [];
  const changed = (r) => (r?.meta?.changes ?? 0) > 0;

  return {
    // ---- users ----
    getUser: (id) => one('SELECT * FROM users WHERE user_id = ?', id),
    getUserByTopic: (topicId) => one('SELECT * FROM users WHERE topic_id = ?', topicId),

    /** Returns the guest row, inserting it first if new (1 read on the common path). */
    async ensureUser(id, name, username, verified) {
      const row = await one('SELECT * FROM users WHERE user_id = ?', id);
      if (row) return row;
      await run(
        'INSERT OR IGNORE INTO users (user_id, name, username, verified, created_at) VALUES (?, ?, ?, ?, ?)',
        id, name, username ?? null, verified ? 1 : 0, now(),
      );
      return one('SELECT * FROM users WHERE user_id = ?', id);
    },

    /** Partial update; keys are trusted column names from this codebase only. */
    updateUser(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return Promise.resolve();
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      return run(`UPDATE users SET ${sets} WHERE user_id = ?`, ...keys.map((k) => fields[k]), id);
    },

    /** Marks topic creation as in progress (topic_id = -user_id). True for one caller. */
    async claimTopic(userId) {
      return changed(await run('UPDATE users SET topic_id = ? WHERE user_id = ? AND topic_id IS NULL', -userId, userId));
    },
    setTopic: (userId, topicId) => run('UPDATE users SET topic_id = ? WHERE user_id = ?', topicId, userId),
    /** Clears topic_id only if it still equals `expected` (stale claim or deleted topic). */
    async resetTopic(userId, expected) {
      return changed(await run('UPDATE users SET topic_id = NULL WHERE user_id = ? AND topic_id = ?', userId, expected));
    },

    /** The guest's inbound messages in the last `seconds`, reading at most limit+1 rows. */
    async recentInbound(guestId, seconds, limit) {
      const row = await one(
        `SELECT COUNT(*) AS n FROM (
           SELECT created_at FROM msg_map WHERE guest_id = ? AND dir = 0
           ORDER BY guest_msg_id DESC LIMIT ?
         ) WHERE created_at > ?`,
        guestId, limit + 1, now() - seconds,
      );
      return row?.n ?? 0;
    },

    // ---- message map ----
    putMaps(rows) {
      if (!rows.length) return Promise.resolve();
      const t = now();
      return d1.batch(rows.map((r) =>
        d1.prepare('INSERT OR REPLACE INTO msg_map (guest_id, guest_msg_id, topic_msg_id, dir, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(r.guestId, r.guestMsgId, r.topicMsgId, r.dir, t)));
    },
    mapByGuestMsg: (guestId, msgId) => one('SELECT * FROM msg_map WHERE guest_id = ? AND guest_msg_id = ?', guestId, msgId),
    mapByTopicMsg: (msgId) => one('SELECT * FROM msg_map WHERE topic_msg_id = ?', msgId),

    // ---- albums ----
    addAlbumItem: (key, msgId) => run('INSERT OR IGNORE INTO album_items (album_key, msg_id) VALUES (?, ?)', key, msgId),
    async claimAlbum(key) {
      return changed(await run('INSERT OR IGNORE INTO albums (album_key, created_at) VALUES (?, ?)', key, now()));
    },
    markAlbumSent: (key) => run('UPDATE albums SET sent = 1 WHERE album_key = ?', key),
    async albumSent(key) {
      return (await one('SELECT sent FROM albums WHERE album_key = ?', key))?.sent === 1;
    },
    /** Atomically reads and marks all untaken items (a D1 batch is one transaction). */
    async takeAlbumItems(key) {
      const [sel] = await d1.batch([
        d1.prepare('SELECT msg_id FROM album_items WHERE album_key = ? AND taken = 0 ORDER BY msg_id').bind(key),
        d1.prepare('UPDATE album_items SET taken = 1 WHERE album_key = ? AND taken = 0').bind(key),
      ]);
      return (sel.results ?? []).map((r) => r.msg_id);
    },
    async takeAlbumItem(key, msgId) {
      return changed(await run('UPDATE album_items SET taken = 1 WHERE album_key = ? AND msg_id = ? AND taken = 0', key, msgId));
    },

    // ---- broadcast ----
    createBroadcast: (srcMsgId) => run('INSERT INTO broadcasts (src_msg_id, created_at) VALUES (?, ?)', srcMsgId, now()),
    activeBroadcast: () => one('SELECT * FROM broadcasts WHERE done = 0 ORDER BY id LIMIT 1'),
    /** Lease the job for `seconds`; true if this caller owns the next batch. */
    async leaseBroadcast(id, seconds) {
      const t = now();
      return changed(await run('UPDATE broadcasts SET lease_until = ? WHERE id = ? AND done = 0 AND lease_until < ?', t + seconds, id, t));
    },
    broadcastTargets: (cursor, limit) =>
      all('SELECT user_id FROM users WHERE user_id > ? AND blocked = 0 AND verified = 1 ORDER BY user_id LIMIT ?', cursor, limit),
    finishBatch: (id, cursor, sent, failed, done) =>
      run('UPDATE broadcasts SET cursor = ?, sent = ?, failed = ?, done = ?, lease_until = 0 WHERE id = ?',
        cursor, sent, failed, done ? 1 : 0, id),
    async cancelBroadcasts() {
      return (await run('UPDATE broadcasts SET done = 1 WHERE done = 0')).meta?.changes ?? 0;
    },

    // ---- stats / maintenance ----
    async stats() {
      const r = await one('SELECT COUNT(*) AS users, SUM(blocked) AS blocked, SUM(verified) AS verified FROM users');
      return { users: r?.users ?? 0, blocked: r?.blocked ?? 0, verified: r?.verified ?? 0 };
    },
    listBlocked: (limit) => all('SELECT user_id, name, username FROM users WHERE blocked = 1 ORDER BY user_id LIMIT ?', limit),

    async cleanup(retentionDays) {
      const cutoff = now() - retentionDays * 86400;
      const albumCutoff = now() - 3600;
      await d1.batch([
        d1.prepare('DELETE FROM msg_map WHERE created_at < ?').bind(cutoff),
        // Also removes orphans whose album row was never written.
        d1.prepare('DELETE FROM album_items WHERE album_key NOT IN (SELECT album_key FROM albums WHERE created_at >= ?)').bind(albumCutoff),
        d1.prepare('DELETE FROM albums WHERE created_at < ?').bind(albumCutoff),
        d1.prepare('DELETE FROM broadcasts WHERE done = 1 AND created_at < ?').bind(cutoff),
      ]);
    },
  };
}
