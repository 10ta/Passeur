// Test doubles: D1 on top of node:sqlite (real SQL, same schema), and a fake
// Telegram API that records calls and can inject failures.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, handleUpdate } from '../src/index.js';
import { TgError } from '../src/telegram.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname;

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  const stats = { reads: 0, writes: 0, queries: 0 };
  const exec = (sql, args, mode) => {
    stats.queries++;
    const st = db.prepare(sql);
    if (mode === 'first') return st.get(...args) ?? null;
    if (mode === 'all') return { results: st.all(...args), meta: {} };
    const r = st.run(...args);
    stats.writes += Number(r.changes);
    return { meta: { changes: Number(r.changes) } };
  };
  const prepare = (sql) => {
    const mk = (args) => ({
      sql, args,
      bind: (...a) => mk(a),
      first: async () => exec(sql, args, 'first'),
      all: async () => exec(sql, args, 'all'),
      run: async () => exec(sql, args, 'run'),
    });
    return mk([]);
  };
  return {
    raw: db,
    stats,
    prepare,
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.args, /^\s*SELECT/i.test(s.sql) ? 'all' : 'run'));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function fakeTelegram() {
  let nextId = 1000;
  let nextThread = 500;
  const calls = [];
  const failures = [];
  const tg = {
    calls,
    /** Fail the next call to `method` matching `pred` with a TgError. */
    failNext(method, code, description, pred = () => true, parameters) {
      failures.push({ method, code, description, pred, parameters });
    },
    of: (method) => calls.filter((c) => c.method === method),
    clear: () => { calls.length = 0; },
    async call(method, params) {
      calls.push({ method, params });
      await new Promise((r) => setImmediate(r)); // simulate I/O, allow interleaving
      const i = failures.findIndex((f) => f.method === method && f.pred(params));
      if (i >= 0) {
        const f = failures.splice(i, 1)[0];
        throw new TgError(method, f.code, f.description, f.parameters);
      }
      switch (method) {
        case 'createForumTopic': return { message_thread_id: nextThread++, name: params.name };
        case 'copyMessages':
        case 'forwardMessages': return params.message_ids.map(() => ({ message_id: nextId++ }));
        case 'getChat': return { id: params.chat_id, is_forum: true };
        case 'getForumTopicIconStickers':
          return [{ emoji: '💡', custom_emoji_id: 'icon-idea' }, { emoji: '❗️', custom_emoji_id: 'icon-waiting' }];
        case 'getWebhookInfo': return { url: 'https://x.example/webhook', pending_update_count: 0 };
        case 'getChatMember':
          return { status: 'administrator', can_manage_topics: true, is_anonymous: false, user: { id: params.user_id } };
        default: return { message_id: nextId++ };
      }
    },
  };
  return tg;
}

export const GROUP = -1001234;
export const ADMIN1 = 11;
export const ADMIN2 = 22;

export function setup(envOverrides = {}) {
  const d1 = fakeD1();
  const tg = fakeTelegram();
  const pending = [];
  const env = {
    DB: d1,
    BOT_TOKEN: '999:TEST',
    WEBHOOK_SECRET: 'sekret',
    ADMIN_IDS: `${ADMIN1},${ADMIN2}`,
    GROUP_ID: String(GROUP),
    VERIFY: '0',
    ...envOverrides,
  };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const app = createApp(env, ctx, { tg, sleep: (ms) => new Promise((r) => setTimeout(r, Math.ceil(ms / 50))) });
  let updateId = 1;
  return {
    d1, tg, app, env, ctx,
    async send(update) {
      await handleUpdate(app, { update_id: updateId++, ...update });
    },
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    row: (sql, ...a) => d1.raw.prepare(sql).get(...a),
    rows: (sql, ...a) => d1.raw.prepare(sql).all(...a),
  };
}

let msgSeq = 1;
export const guest = (id, extra = {}) => ({
  message: {
    message_id: msgSeq++, date: 0,
    chat: { id, type: 'private' },
    from: { id, is_bot: false, first_name: `Guest${id}`, username: `g${id}` },
    text: 'hello', ...extra,
  },
});
export const cmdEntities = (text) => [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];
export const inTopic = (thread, from = ADMIN1, extra = {}) => ({
  message: {
    message_id: msgSeq++, date: 0,
    chat: { id: GROUP, type: 'supergroup', is_forum: true },
    from: { id: from, is_bot: false, first_name: 'Admin' },
    is_topic_message: true, message_thread_id: thread,
    text: 'reply', ...extra,
  },
});
export const inGeneral = (from = ADMIN1, extra = {}) => ({
  message: {
    message_id: msgSeq++, date: 0,
    chat: { id: GROUP, type: 'supergroup', is_forum: true },
    from: { id: from, is_bot: false, first_name: 'Admin' },
    text: 'hi', ...extra,
  },
});
export const nextMsgId = () => msgSeq++;
