// Worker entry: Telegram webhook (POST /webhook) and the 5-minute cron.

import { loadConfig } from './config.js';
import { createTelegram } from './telegram.js';
import { createDb } from './db.js';
import { handleGuestMessage, handleGuestEdit, handleCaptchaCallback } from './guest.js';
import { handleGroupMessage, handleGroupEdit } from './admin.js';
import { runBroadcastBatch } from './broadcast.js';
import { handleListCallback } from './lists.js';
import { handleSettingsCallback, getSetting } from './settings.js';
import { handleForgetCallback } from './forget.js';
import { checkWebhook } from './health.js';

const CLEANUP_HOUR_UTC = 3;

export function createApp(env, ctx, overrides = {}) {
  const cfg = loadConfig(env);
  const tg = overrides.tg ?? createTelegram(cfg.token);
  const app = {
    cfg,
    env, // raw values for settings.js (.env layer)
    tg,
    db: createDb(env.DB),
    waitUntil: (p) => ctx.waitUntil(p),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    /** Posts to the General topic of the admin group; never throws. */
    async notify(text) {
      if (!cfg.groupId) return;
      await tg.call('sendMessage', { chat_id: cfg.groupId, text, link_preview_options: { is_disabled: true } })
        .catch((err) => console.error('notify failed', err.message));
    },
  };
  return app;
}

export async function handleUpdate(app, update) {
  const msg = update.message;
  if (msg) {
    if (msg.chat.type === 'private') return handleGuestMessage(app, msg);
    if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') return handleGroupMessage(app, msg);
    return;
  }
  const edited = update.edited_message;
  if (edited) {
    if (edited.chat.type === 'private') return handleGuestEdit(app, edited);
    return handleGroupEdit(app, edited);
  }
  const cq = update.callback_query;
  if (cq && typeof cq.data === 'string' && cq.data.startsWith('cap:')) return handleCaptchaCallback(app, cq);
  if (cq && typeof cq.data === 'string' && cq.data.startsWith('lm:')) return handleListCallback(app, cq);
  if (cq && typeof cq.data === 'string' && cq.data.startsWith('st:')) return handleSettingsCallback(app, cq);
  if (cq && typeof cq.data === 'string' && cq.data.startsWith('fg:')) return handleForgetCallback(app, cq);
  if (cq) await app.tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/') return new Response('ok\n');
    if (request.method !== 'POST' || pathname !== '/webhook') return new Response('not found\n', { status: 404 });

    const cfg = loadConfig(env);
    if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token'), cfg.webhookSecret)) {
      return new Response('unauthorized\n', { status: 401 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request\n', { status: 400 });
    }

    const app = createApp(env, ctx);
    try {
      await handleUpdate(app, update);
    } catch (err) {
      // Always 200: a Telegram retry would re-send messages that already went out.
      console.error(`update ${update.update_id} failed:`, err?.stack ?? err);
      ctx.waitUntil(app.notify(`⚠️ 处理 update ${update.update_id} 失败：${err?.message ?? err}`));
    }
    return new Response('ok\n');
  },

  async scheduled(event, env, ctx) {
    const app = createApp(env, ctx);
    if (!app.cfg.groupId) return;
    const at = new Date(event.scheduledTime);
    const tasks = [runBroadcastBatch(app), checkWebhook(app)];
    if (at.getUTCHours() === CLEANUP_HOUR_UTC && at.getUTCMinutes() < 5) tasks.push(getSetting(app, 'retention_days').then((d) => app.db.cleanup(Math.max(1, Number(d)))));
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') console.error('cron task failed', r.reason?.message ?? r.reason);
  },
};
