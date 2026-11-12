// Mirrors of list messages inside each recipient's own topic, so a guest's
// history (and their replies) sit in one place.
//
// fanOut records a pending row per delivered member, then mirrors as many as
// the invocation budget and Telegram's per-group rate limit (~20 messages a
// minute) allow. Whatever is left is mirrored when that guest next writes
// (fillPending), just before their message, so a reply always has its context.
//
// Guest messages in a topic are copies posted by the bot, so a mirror must not
// look like one. It is a silent *forward* of the admin's message: the
// "Forwarded from <admin>" header at the top says who sent it. When the
// admin's message was itself a forward, that header would name the original
// source (just like something the guest forwarded), so a "📤 群发 · <list>"
// line goes first. An album is mirrored as one labelled line.
// The msg_map row (guest copy <-> mirror, dir OUT) makes replies thread.

import { DIR_OUT } from './db.js';
import { TgError } from './telegram.js';

const FILL_MAX = 3; // on a guest message: mirror at most the latest N pending…
const FILL_WINDOW_S = 48 * 3600; // …sent within this window (a replied-to one is always mirrored)

const messageLink = (groupId, topicId, msgId) =>
  `https://t.me/c/${String(groupId).replace(/^-100/, '')}/${topicId}/${msgId}`;

/** Bot API calls one mirror costs. */
const cost = (p) => (!p.is_album && p.fwd ? 2 : 1);

/** Posts one mirror into `topicId`; returns its message id. */
async function mirrorOne(app, topicId, p) {
  const { cfg, tg } = app;
  const label = (text) => tg.call('sendMessage', {
    chat_id: cfg.groupId, message_thread_id: topicId, text, disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: '查看原消息', url: messageLink(cfg.groupId, p.list_topic_id, p.list_msg_id) }]] },
  });
  if (p.is_album) return (await label(`📤 群发相册 · ${p.label}`)).message_id;
  if (p.fwd) await label(`📤 群发 · ${p.label}`);
  const res = await tg.call('forwardMessage', {
    chat_id: cfg.groupId, from_chat_id: cfg.groupId, message_id: p.list_msg_id,
    message_thread_id: topicId, disable_notification: true,
  });
  return res.message_id;
}

const mapRow = (p, mirrorId) => ({ guestId: p.user_id, guestMsgId: p.guest_msg_id, topicMsgId: mirrorId, dir: DIR_OUT });

/**
 * After a fan-out. `delivered` = [{ user_id, topic_id, guest_msg_id }];
 * `budget` = Bot API calls this invocation can still spend on mirrors.
 */
export async function mirrorDelivered(app, delivered, info, budget) {
  const { db } = app;
  const rows = delivered.map((d) => ({ ...info, user_id: d.user_id, guest_msg_id: d.guest_msg_id }));
  await db.addPending(rows);
  const done = [];
  let used = 0;
  for (let i = 0; i < delivered.length; i++) {
    if (!(delivered[i].topic_id > 0)) continue; // no topic yet: mirrored when they write
    if (used + cost(rows[i]) > budget) break;
    used += cost(rows[i]);
    try {
      done.push([rows[i], await mirrorOne(app, delivered[i].topic_id, rows[i])]);
    } catch (err) {
      if (err instanceof TgError && err.code === 429) break; // group rate limit: the rest stays pending
      console.error('mirror failed', err.message);
    }
  }
  await db.settlePending(done.map(([p]) => p), done.map(([p, id]) => mapRow(p, id)));
}

/** Before relaying a guest's message: mirror what they received but their topic doesn't show yet. */
export async function fillPending(app, userId, topicId, repliedGuestMsgId) {
  const { db } = app;
  const pending = await db.pendingFor(userId);
  if (!pending.length) return;
  const cutoff = Math.floor(Date.now() / 1000) - FILL_WINDOW_S;
  const recent = pending.filter((p) => p.created_at >= cutoff).slice(-FILL_MAX);
  const replied = pending.find((p) => p.guest_msg_id === repliedGuestMsgId);
  const chosen = replied && !recent.includes(replied) ? [replied, ...recent] : recent;
  const done = [];
  for (const p of chosen) {
    try {
      done.push([p, await mirrorOne(app, topicId, p)]);
    } catch (err) {
      console.error('mirror (on reply) failed', err.message);
    }
  }
  // Everything pending is settled now: older ones are dropped rather than replayed later.
  await db.settlePending(pending, done.map(([p, id]) => mapRow(p, id)));
}
