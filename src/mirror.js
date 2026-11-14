// Mirrors of list messages inside each recipient's own topic, so a guest's
// history (and their replies) sit in one place.
//
// fanOut records a pending row per delivered member, then mirrors as many as
// the invocation budget and Telegram's per-group rate limit (~20 messages a
// minute) allow. Whatever is left is mirrored when that guest next writes
// (fillPending), just before their message, so a reply always has its context.
//
// Guest messages in a topic are copies posted by the bot, so a mirror must not
// be a copy: it is a silent *forward* of the admin's message (an album as a
// whole), whose "Forwarded from <admin>" header shows who sent it. Nothing
// else is posted: no label lines, no buttons. (A message with buttons also
// breaks Telegram's grouping of consecutive messages, which made sender names
// appear inconsistently.)
// Known limit: when the admin's list message was itself a forward, its header
// names the original source, just like something the guest forwarded.
// The msg_map row (guest copy <-> mirror, dir OUT) makes replies thread.
//
// The list_mirror setting (global or per list) picks the mode: all (mirror at
// once, rest on reply), reply (only on reply), off (no mirrors at all).

import { DIR_OUT } from './db.js';
import { TgError } from './telegram.js';

const FILL_MAX = 3; // on a guest message: mirror at most the latest N pending…
const FILL_WINDOW_S = 48 * 3600; // …sent within this window (a replied-to one is always mirrored)

/** Forwards the admin's list message (or whole album) into `topicId`; returns the first mirror's id. */
async function mirrorOne(app, topicId, p) {
  const { cfg, tg } = app;
  const ids = p.msg_ids ? p.msg_ids.split(',').map(Number) : [p.list_msg_id];
  const base = { chat_id: cfg.groupId, from_chat_id: cfg.groupId, message_thread_id: topicId, disable_notification: true };
  if (ids.length > 1) {
    const res = await tg.call('forwardMessages', { ...base, message_ids: ids });
    return res[0].message_id;
  }
  return (await tg.call('forwardMessage', { ...base, message_id: ids[0] })).message_id;
}

const mapRow = (p, mirrorId) => ({ guestId: p.user_id, guestMsgId: p.guest_msg_id, topicMsgId: mirrorId, dir: DIR_OUT });

/**
 * After a fan-out. `delivered` = [{ user_id, topic_id, guest_msg_id }];
 * `budget` = Bot API calls this invocation can still spend on mirrors.
 */
export async function mirrorDelivered(app, delivered, info, budget, mode) {
  const { db } = app;
  if (mode === 'off') return;
  const rows = delivered.map((d) => ({ ...info, user_id: d.user_id, guest_msg_id: d.guest_msg_id }));
  await db.addPending(rows);
  if (mode === 'reply') return; // mirrored only if and when each guest writes
  const done = [];
  for (let i = 0; i < delivered.length && done.length < budget; i++) {
    if (!(delivered[i].topic_id > 0)) continue; // no topic yet: mirrored when they write
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
