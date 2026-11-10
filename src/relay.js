// Moving messages between a guest's private chat and their forum topic.
//
// A "route" describes one direction:
//   { fromChat, toChat, threadId?, forward, replyTo?, mapRow(srcId, dstId), recoverThread?, onSent? }
// recoverThread(err) is called once when the destination topic was deleted or
// closed and returns the thread id to retry with (or throws).

import { TgError } from './telegram.js';
import { topicName, userCard, displayName } from './text.js';

export const ALBUM_WAIT_MS = 2500;
const TOPIC_POLL_MS = 500;
const TOPIC_POLL_TRIES = 6;

const isTopicProblem = (err) => err instanceof TgError && (err.threadGone || err.topicClosed);

/** Sends one message along `route`; records the message pair. Returns the new message id. */
export async function sendSingle(app, route, srcMsgId) {
  const build = (threadId) => {
    const p = { chat_id: route.toChat, from_chat_id: route.fromChat, message_id: srcMsgId };
    if (threadId) p.message_thread_id = threadId;
    if (!route.forward && route.replyTo) {
      p.reply_parameters = { message_id: route.replyTo, allow_sending_without_reply: true };
    }
    return p;
  };
  const method = route.forward ? 'forwardMessage' : 'copyMessage';
  let res;
  try {
    res = await app.tg.call(method, build(route.threadId));
  } catch (err) {
    if (!(route.recoverThread && isTopicProblem(err))) throw err;
    res = await app.tg.call(method, build(await route.recoverThread(err)));
  }
  await app.db.putMaps([route.mapRow(srcMsgId, res.message_id)]);
  await route.onSent?.();
  return res.message_id;
}

/**
 * Handles one item of a media group. The first item to arrive becomes the
 * leader: it waits ALBUM_WAIT_MS (wall time, no CPU) in waitUntil, then hands
 * every buffered item to `send.group(ids)` so the album stays grouped. Items
 * arriving after the album went out go through `send.single(id)`.
 * `onError(err)` reports failures that happen after the webhook returned.
 */
export async function bufferAlbum(app, fromChat, msg, send, onError) {
  const key = `${fromChat}:${msg.media_group_id}`;
  await app.db.addAlbumItem(key, msg.message_id);
  if (await app.db.claimAlbum(key)) {
    app.waitUntil((async () => {
      try {
        await app.sleep(ALBUM_WAIT_MS);
        await app.db.markAlbumSent(key); // must precede take: see takeAlbumItem below
        const ids = await app.db.takeAlbumItems(key);
        if (ids.length) await send.group(ids);
      } catch (err) {
        await onError(err);
      }
    })());
    return;
  }
  // Late item: album already sent (sent=1 is written before items are taken,
  // so if we read sent=1 here, our row either was taken by the album or is
  // still ours to take — never both).
  if ((await app.db.albumSent(key)) && (await app.db.takeAlbumItem(key, msg.message_id))) {
    await send.single(msg.message_id);
  }
}

/** One album item along a single route (guest <-> their topic). */
export function sendAlbumItem(app, route, msg, onError) {
  return bufferAlbum(app, route.fromChat, msg, {
    group: (ids) => sendGroup(app, route, ids),
    single: (id) => sendSingle(app, route, id),
  }, onError);
}

async function sendGroup(app, route, ids) {
  if (ids.length === 1) {
    await sendSingle(app, route, ids[0]);
    return;
  }
  const method = route.forward ? 'forwardMessages' : 'copyMessages';
  const build = (threadId) => {
    const p = { chat_id: route.toChat, from_chat_id: route.fromChat, message_ids: ids };
    if (threadId) p.message_thread_id = threadId;
    return p;
  };
  let res;
  try {
    res = await app.tg.call(method, build(route.threadId));
  } catch (err) {
    if (!(route.recoverThread && isTopicProblem(err))) throw err;
    res = await app.tg.call(method, build(await route.recoverThread(err)));
  }
  // Results are in source order; if Telegram skipped some, we cannot pair them safely.
  if (Array.isArray(res) && res.length === ids.length) {
    await app.db.putMaps(ids.map((src, i) => route.mapRow(src, res[i].message_id)));
  }
  await route.onSent?.();
}

// ---------------------------------------------------------------------------
// Topics

/**
 * Returns the guest's topic id, creating the topic if needed. Concurrent
 * first messages race on claimTopic(); losers poll until the winner is done.
 */
export async function ensureTopic(app, from, user) {
  if (user.topic_id > 0) return user.topic_id;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await app.db.claimTopic(from.id)) return createTopic(app, from, null);
    for (let i = 0; i < TOPIC_POLL_TRIES; i++) {
      await app.sleep(TOPIC_POLL_MS);
      const row = await app.db.getUser(from.id);
      if (row?.topic_id > 0) return row.topic_id;
      if (row?.topic_id == null) break; // creator failed and released the claim
    }
    // A claim older than the poll window means the creator died: release it.
    await app.db.resetTopic(from.id, -from.id);
  }
  throw new Error(`topic for ${from.id} is still being created`);
}

/** The stored topic no longer exists: create a new one. */
export async function recreateTopic(app, from, oldTopicId) {
  await app.db.resetTopic(from.id, oldTopicId);
  const user = await app.db.getUser(from.id);
  if (user?.topic_id > 0) return user.topic_id; // someone else already recreated it
  if (await app.db.claimTopic(from.id)) return createTopic(app, from, '♻️ 原话题已被删除，已重新创建。');
  return ensureTopic(app, from, user ?? { topic_id: null });
}

async function createTopic(app, from, note) {
  const { groupId } = app.cfg;
  try {
    const topic = await app.tg.call('createForumTopic', {
      chat_id: groupId,
      name: topicName(displayName(from), from.id, (await app.db.getUser(from.id))?.source),
    });
    const id = topic.message_thread_id;
    await app.db.setTopic(from.id, id);
    const row = await app.db.getUser(from.id);
    await app.tg.call('sendMessage', {
      chat_id: groupId,
      message_thread_id: id,
      text: (note ? `${note}\n\n` : '') + userCard(from, row),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }).catch((err) => console.error('user card failed', err.message));
    return id;
  } catch (err) {
    await app.db.resetTopic(from.id, -from.id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Edits

/** Mirrors a text/caption edit onto our copy. Media replacement is not synced. */
export async function syncEdit(app, chatId, copyId, src) {
  try {
    if (typeof src.text === 'string') {
      await app.tg.call('editMessageText', {
        chat_id: chatId, message_id: copyId, text: src.text, entities: src.entities,
        link_preview_options: src.link_preview_options,
      });
    } else {
      await app.tg.call('editMessageCaption', {
        chat_id: chatId, message_id: copyId, caption: src.caption ?? '', caption_entities: src.caption_entities,
      });
    }
  } catch (err) {
    if (err instanceof TgError && err.notModified) return;
    console.error('edit sync failed', err.message);
  }
}
