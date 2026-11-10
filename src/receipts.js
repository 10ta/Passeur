// Delivery / "seen" marks, on the latest admin message of a guest topic only.
//   👌 the copy reached the guest
//   👀 the guest has written since (Telegram gives bots no read status, so
//      this is inferred: they opened the chat after our message)
// When a newer message is delivered, the mark moves: the old one is cleared,
// so a topic never fills up with reactions.

import { getSetting } from './settings.js';

const react = (app, msgId, emoji) => app.tg.call('setMessageReaction', {
  chat_id: app.cfg.groupId,
  message_id: msgId,
  reaction: emoji ? [{ type: 'emoji', emoji }] : [],
});

/** After an admin message in `user`'s topic was delivered (`topicMsgId` = the admin's message). */
export async function markDelivered(app, user, topicMsgId) {
  try {
    if ((await getSetting(app, 'receipts', user.topic_id)) !== '1') return;
    const prev = user.receipt_msg_id;
    if (prev && prev !== topicMsgId) await react(app, prev, null).catch(() => {}); // may be deleted already
    await react(app, topicMsgId, '👌');
    await app.db.updateUser(user.user_id, { receipt_msg_id: topicMsgId, receipt_seen: 0 });
    user.receipt_msg_id = topicMsgId;
    user.receipt_seen = 0;
  } catch (err) {
    console.error('delivery mark failed', err.message);
  }
}

/** After the guest wrote something: upgrade the pending 👌 to 👀 (once). */
export async function markSeen(app, user) {
  if (!user.receipt_msg_id || user.receipt_seen) return;
  try {
    if ((await getSetting(app, 'receipts', user.topic_id)) !== '1') return;
    await react(app, user.receipt_msg_id, '👀');
    await app.db.updateUser(user.user_id, { receipt_seen: 1 });
    user.receipt_seen = 1;
  } catch (err) {
    console.error('seen mark failed', err.message);
  }
}
