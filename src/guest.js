// Private chats with guests: welcome, captcha, rate limit, relay to topic, edits.

import { DIR_IN, now } from './db.js';
import { TgError } from './telegram.js';
import { displayName, topicName, T } from './text.js';
import { ensureTopic, recreateTopic, sendSingle, sendAlbumItem, syncEdit } from './relay.js';
import { parseCommand } from './commands.js';
import { getSetting } from './settings.js';

const CAPTCHA_TTL = 600; // a challenge older than this is replaced on the next message
const CAPTCHA_MAX_FAILS = 3;
const LOCK_SECONDS = 1800;
const NOTICE_EVERY = 60; // throttle for "slow down" / "locked" replies

const reply = (app, chatId, text, extra = {}) =>
  app.tg.call('sendMessage', { chat_id: chatId, text, ...extra });

export async function handleGuestMessage(app, msg) {
  const { cfg, db } = app;
  const from = msg.from;
  if (!from || from.is_bot) return;
  const cmd = parseCommand(msg);

  if (cmd?.name === 'id') return reply(app, msg.chat.id, `Your ID: ${from.id}`);
  if (cfg.adminIds.has(from.id)) return reply(app, msg.chat.id, T.adminDm);
  if (!cfg.groupId) return; // setup mode: nothing to relay to yet

  const verify = (await getSetting(app, 'verify')) === '1';
  const user = await db.ensureUser(from.id, displayName(from), from.username, !verify);
  if (user.blocked) return;

  if (cmd?.name === 'start') {
    await reply(app, msg.chat.id, cfg.welcomeText);
    if (verify && !user.verified) await challenge(app, msg.chat.id, user, null);
    return;
  }
  if (verify && !user.verified) return handleUnverified(app, msg, user);

  const limit = Number(await getSetting(app, 'rate_limit'));
  if (limit > 0) {
    const n = await db.recentInbound(from.id, 60, limit);
    if (n >= limit) {
      if (now() - user.notice_at > NOTICE_EVERY) {
        await db.updateUser(from.id, { notice_at: now() });
        await reply(app, msg.chat.id, T.rateLimited);
      }
      return;
    }
  }

  await refreshProfile(app, from, user);
  await relayToTopic(app, msg, from, user);
}

/** Relays a guest message (or a pending message id after captcha) into the topic. */
export async function relayToTopic(app, msg, from, user) {
  const { cfg, db } = app;
  let topicId;
  try {
    topicId = await ensureTopic(app, from, user);
  } catch (err) {
    // e.g. wrong GROUP_ID or the bot lost "Manage Topics": tell the guest, then report.
    await guestFailure(app, from.id, err, false);
    return;
  }
  let replyTo;
  if (msg.reply_to_message) {
    replyTo = (await db.mapByGuestMsg(from.id, msg.reply_to_message.message_id))?.topic_msg_id;
  }
  const route = {
    fromChat: from.id,
    toChat: cfg.groupId,
    threadId: topicId,
    // Keep the original source visible to admins when the guest forwards something.
    forward: Boolean(msg.forward_origin),
    replyTo,
    mapRow: (src, dst) => ({ guestId: from.id, guestMsgId: src, topicMsgId: dst, dir: DIR_IN }),
    recoverThread: async (err) => {
      if (err.topicClosed) {
        // An admin closed the topic; a new guest message reopens it rather than forking history.
        await app.tg.call('reopenForumTopic', { chat_id: cfg.groupId, message_thread_id: topicId });
        return topicId;
      }
      return (topicId = await recreateTopic(app, from, topicId));
    },
  };
  try {
    if (msg.media_group_id) {
      await sendAlbumItem(app, route, msg, (err) => guestFailure(app, from.id, err, true));
    } else {
      await sendSingle(app, route, msg.message_id);
    }
  } catch (err) {
    await guestFailure(app, from.id, err, false);
  }
}

async function guestFailure(app, guestId, err, deferred) {
  const unsupported = err instanceof TgError && /can't be (copied|forwarded)|protected/i.test(err.description);
  await reply(app, guestId, unsupported ? T.unsupported : T.sendFailed).catch(() => {});
  if (unsupported) return;
  if (deferred) {
    console.error('album relay failed', err.message);
    await app.notify(`⚠️ 相册转达失败 (guest ${guestId}): ${err.message}`);
    return;
  }
  throw err; // top-level handler logs and notifies admins
}

async function refreshProfile(app, from, user) {
  const name = displayName(from);
  const username = from.username ?? null;
  if (name === user.name && username === (user.username ?? null)) return;
  await app.db.updateUser(from.id, { name, username });
  if (user.topic_id > 0) {
    await app.tg.call('editForumTopic', {
      chat_id: app.cfg.groupId, message_thread_id: user.topic_id, name: topicName(name, from.id),
    }).catch((err) => console.error('rename topic failed', err.message));
  }
}

// ---------------------------------------------------------------------------
// Captcha

function randInt(min, max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min + 1));
}

function makeChallenge() {
  const a = randInt(1, 9);
  const b = randInt(1, 9);
  const answer = a + b;
  const options = new Set([answer]);
  while (options.size < 4) options.add(randInt(2, 18));
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return {
    answer,
    text: T.verifyPrompt(a, b),
    reply_markup: { inline_keyboard: [shuffled.map((n) => ({ text: String(n), callback_data: `cap:${n}` }))] },
  };
}

/** Sends a new challenge, or replaces the one in `editMsgId`. */
async function challenge(app, chatId, user, editMsgId, extraFields = {}) {
  const c = makeChallenge();
  await app.db.updateUser(user.user_id, { captcha_answer: c.answer, captcha_sent_at: now(), ...extraFields });
  if (editMsgId) {
    await app.tg.call('editMessageText', { chat_id: chatId, message_id: editMsgId, text: c.text, reply_markup: c.reply_markup });
  } else {
    await reply(app, chatId, c.text, { reply_markup: c.reply_markup });
  }
}

async function handleUnverified(app, msg, user) {
  const t = now();
  const chatId = msg.chat.id;
  if (user.locked_until > t) {
    if (t - user.notice_at > NOTICE_EVERY) {
      await app.db.updateUser(user.user_id, { notice_at: t });
      await reply(app, chatId, T.verifyLocked(Math.ceil((user.locked_until - t) / 60)));
    }
    return;
  }
  // Keep the first message so it can be delivered once the guest passes.
  const pending = user.pending_msg_id == null ? { pending_msg_id: msg.message_id } : {};
  if (user.captcha_answer == null || t - user.captcha_sent_at > CAPTCHA_TTL) {
    await challenge(app, chatId, user, null, pending);
  } else if (pending.pending_msg_id) {
    await app.db.updateUser(user.user_id, pending);
  }
}

export async function handleCaptchaCallback(app, cq) {
  const { db } = app;
  const answer = (text, alert = false) =>
    app.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;
  if (cq.message?.chat?.type !== 'private' || !app.cfg.groupId) return answer();

  const user = await db.getUser(cq.from.id);
  if (!user || user.blocked) return answer();
  if (user.verified) return answer('✅');
  const t = now();
  if (user.locked_until > t) return answer(T.verifyLocked(Math.ceil((user.locked_until - t) / 60)), true);

  const picked = Number.parseInt(String(cq.data).slice(4), 10);
  if (user.captcha_answer != null && picked === user.captcha_answer) {
    await db.updateUser(user.user_id, {
      verified: 1, captcha_answer: null, captcha_fails: 0, pending_msg_id: null,
    });
    await answer('✅');
    const pendingId = user.pending_msg_id;
    if (pendingId) {
      await relayToTopic(app, { message_id: pendingId }, cq.from, { ...user, verified: 1 });
    }
    await app.tg.call('editMessageText', {
      chat_id: chatId, message_id: msgId, text: pendingId ? T.verifyOk : T.verifyOkNoPending,
    }).catch(() => {});
    return;
  }

  const fails = user.captcha_fails + 1;
  if (fails >= CAPTCHA_MAX_FAILS) {
    await db.updateUser(user.user_id, { locked_until: t + LOCK_SECONDS, captcha_fails: 0, captcha_answer: null });
    await answer('❌');
    await app.tg.call('editMessageText', {
      chat_id: chatId, message_id: msgId, text: T.verifyLocked(LOCK_SECONDS / 60),
    }).catch(() => {});
    return;
  }
  await answer('❌');
  await challenge(app, chatId, user, msgId, { captcha_fails: fails });
}

// ---------------------------------------------------------------------------
// Edits

export async function handleGuestEdit(app, msg) {
  const { cfg, db } = app;
  const from = msg.from;
  if (!from || !cfg.groupId || cfg.adminIds.has(from.id)) return;
  const map = await db.mapByGuestMsg(from.id, msg.message_id);
  if (!map || map.dir !== DIR_IN) return;
  const user = await db.getUser(from.id);
  if (!user || user.blocked) return;
  await syncEdit(app, cfg.groupId, map.topic_msg_id, msg);
}
