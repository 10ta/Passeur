// Topic status icon: a guest's topic shows the "waiting" icon from the moment
// they write until an admin's reply is delivered, so the sidebar doubles as
// an inbox. Only state changes cost a Bot API call (users.waiting).
//
// Icons must come from getForumTopicIconStickers; the chosen id is cached in
// settings (scope 'i'). An empty icon id restores the default icon.

import { getSetting } from './settings.js';

const ICON_SCOPE = 'i';
const WAITING_PREFERENCE = ['❗', '‼', '🔥', '💬', '❓'];

async function waitingIcon(app) {
  const cached = (await app.db.getSettings(ICON_SCOPE)).waiting;
  if (cached) return cached;
  const stickers = await app.tg.call('getForumTopicIconStickers', {});
  const strip = (e) => String(e ?? '').replace(/️/g, '');
  let pick;
  for (const want of WAITING_PREFERENCE) {
    pick = stickers.find((s) => strip(s.emoji) === want);
    if (pick) break;
  }
  pick ??= stickers[0];
  if (!pick?.custom_emoji_id) throw new Error('no forum topic icons available');
  await app.db.setSetting(ICON_SCOPE, 'waiting', pick.custom_emoji_id);
  return pick.custom_emoji_id;
}

async function setIcon(app, topicId, iconId) {
  await app.tg.call('editForumTopic', { chat_id: app.cfg.groupId, message_thread_id: topicId, icon_custom_emoji_id: iconId });
}

const enabled = async (app) => (await getSetting(app, 'topic_status')) === '1';

/** The guest wrote: show "waiting" (once until answered). */
export async function markWaiting(app, user) {
  if (user.waiting || !(user.topic_id > 0)) return;
  try {
    if (!(await enabled(app))) return;
    await setIcon(app, user.topic_id, await waitingIcon(app));
    await app.db.updateUser(user.user_id, { waiting: 1 });
    user.waiting = 1;
  } catch (err) {
    console.error('status icon (waiting) failed', err.message);
  }
}

/** An admin reply reached the guest: restore the default icon. */
export async function markAnswered(app, user) {
  if (!user.waiting || !(user.topic_id > 0)) return;
  try {
    await setIcon(app, user.topic_id, ''); // cleared even if the setting was switched off meanwhile
    await app.db.updateUser(user.user_id, { waiting: 0 });
    user.waiting = 0;
  } catch (err) {
    console.error('status icon (answered) failed', err.message);
  }
}
