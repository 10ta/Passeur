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
    // ---- settings (src/settings.js) ----
    async getSettings(scope) {
      const rows = await all('SELECT key, value FROM settings WHERE scope = ?', scope);
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    setSetting: (scope, key, value) => run('INSERT OR REPLACE INTO settings (scope, key, value) VALUES (?, ?, ?)', scope, key, value),
    /** Insert or update, writing nothing when the value is unchanged. */
    upsertSetting: (scope, key, value) => run(
      `INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value`,
      scope, key, value),
    /** Topic ids that have their own settings (range scan on the primary key). */
    async topicsWithSettings() {
      const rows = await all("SELECT DISTINCT scope FROM settings WHERE scope >= 't:' AND scope < 't;'");
      return new Set(rows.map((r) => Number(r.scope.slice(2))));
    },
    allLists: () => all(
      `SELECT l.topic_id, l.name, (SELECT COUNT(*) FROM list_members m WHERE m.topic_id = l.topic_id) AS n
       FROM lists l ORDER BY l.created_at`),
    renameList: (topicId, name) => run('UPDATE lists SET name = ? WHERE topic_id = ?', name, topicId),
    deleteList: (topicId) => d1.batch([
      d1.prepare('DELETE FROM list_members WHERE topic_id = ?').bind(topicId),
      d1.prepare('DELETE FROM settings WHERE scope = ?').bind(`t:${topicId}`),
      d1.prepare('DELETE FROM lists WHERE topic_id = ?').bind(topicId),
    ]),
    /** Erases a guest (/forget). The Telegram topic is handled by the caller. */
    forgetUser: (userId, topicId) => d1.batch([
      d1.prepare('DELETE FROM msg_map WHERE guest_id = ?').bind(userId),
      d1.prepare('DELETE FROM list_members WHERE user_id = ?').bind(userId),
      d1.prepare('DELETE FROM list_pending WHERE user_id = ?').bind(userId),
      d1.prepare('DELETE FROM settings WHERE scope = ?').bind(`t:${topicId}`),
      d1.prepare('DELETE FROM users WHERE user_id = ?').bind(userId),
    ]),
    deleteSetting: (scope, key) => run('DELETE FROM settings WHERE scope = ? AND key = ?', scope, key),

    // ---- list mirrors (src/mirror.js) ----
    addPending(rows) {
      if (!rows.length) return Promise.resolve();
      const t = now();
      return d1.batch(rows.map((r) =>
        d1.prepare('INSERT OR REPLACE INTO list_pending (user_id, list_msg_id, list_topic_id, guest_msg_id, is_album, label, created_at, fwd, msg_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(r.user_id, r.list_msg_id, r.list_topic_id, r.guest_msg_id, r.is_album, r.label, t, r.fwd ?? 0, r.msg_ids ?? null)));
    },
    /** A guest's pending mirrors, oldest first (primary-key prefix; usually empty). */
    pendingFor: (userId) => all('SELECT * FROM list_pending WHERE user_id = ? ORDER BY created_at, list_msg_id', userId),
    /** Removes pending rows and records the mirrors' message pairs, in one transaction. */
    settlePending(rows, maps) {
      if (!rows.length) return Promise.resolve();
      const t = now();
      return d1.batch([
        ...rows.map((r) => d1.prepare('DELETE FROM list_pending WHERE user_id = ? AND list_msg_id = ?').bind(r.user_id, r.list_msg_id)),
        ...maps.map((m) => d1.prepare('INSERT OR REPLACE INTO msg_map (guest_id, guest_msg_id, topic_msg_id, dir, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(m.guestId, m.guestMsgId, m.topicMsgId, m.dir, t)),
      ]);
    },

    // ---- list topics ----
    createList: (topicId, name) => run('INSERT INTO lists (topic_id, name, created_at) VALUES (?, ?, ?)', topicId, name, now()),
    getList: (topicId) => one('SELECT * FROM lists WHERE topic_id = ?', topicId),
    /** Members with their state, for sending and for the panel. */
    listMembers: (topicId) => all(
      `SELECT u.user_id, u.name, u.blocked, u.topic_id FROM list_members m JOIN users u ON u.user_id = m.user_id
       WHERE m.topic_id = ? ORDER BY u.name`, topicId),
    addMember: (topicId, userId) => run('INSERT OR IGNORE INTO list_members (topic_id, user_id) VALUES (?, ?)', topicId, userId),
    removeMember: (topicId, userId) => run('DELETE FROM list_members WHERE topic_id = ? AND user_id = ?', topicId, userId),
    /** Guests with a topic, most recently active first (panel only; not a per-message query). */
    recentGuests: (limit, offset = 0) => all(
      `SELECT u.user_id, u.name, u.blocked, u.topic_id FROM users u WHERE u.topic_id > 0
       ORDER BY COALESCE((SELECT MAX(m.created_at) FROM msg_map m WHERE m.guest_id = u.user_id), u.created_at) DESC, u.user_id
       LIMIT ? OFFSET ?`, limit, offset),
    listBlocked: (limit) => all('SELECT user_id, name, username FROM users WHERE blocked = 1 ORDER BY user_id LIMIT ?', limit),

    async cleanup(retentionDays) {
      const cutoff = now() - retentionDays * 86400;
      const albumCutoff = now() - 3600;
      await d1.batch([
        d1.prepare('DELETE FROM msg_map WHERE created_at < ?').bind(cutoff),
        d1.prepare('DELETE FROM list_pending WHERE created_at < ?').bind(now() - 7 * 86400),
        // Also removes orphans whose album row was never written.
        d1.prepare('DELETE FROM album_items WHERE album_key NOT IN (SELECT album_key FROM albums WHERE created_at >= ?)').bind(albumCutoff),
        d1.prepare('DELETE FROM albums WHERE created_at < ?').bind(albumCutoff),
        d1.prepare('DELETE FROM broadcasts WHERE done = 1 AND created_at < ?').bind(cutoff),
      ]);
    },
  };
}
