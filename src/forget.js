// /forget in a guest topic: erase everything the bot keeps about that guest.
// Always confirmed with a button; deleting the Telegram topic (irreversible,
// removes its history) is a separate, explicit choice.

import { esc } from './text.js';

export async function startForget(app, msg, user, replyIn) {
  const t = msg.message_thread_id;
  return replyIn(app, msg, [
    `删除 <b>${esc(user.name || user.user_id)}</b>（<code>${user.user_id}</code>）在 bot 里的全部记录？`,
    '包括：验证与拉黑状态、来源、消息对应关系、名单成员身份、会话设置。',
    '之后对方再发消息，会被当作新访客（重新验证、新建话题）。',
  ].join('\n'), {
    reply_markup: { inline_keyboard: [
      [{ text: '删除记录，保留话题', callback_data: `fg:${t}:r` }],
      [{ text: '删除记录并删除话题（不可恢复）', callback_data: `fg:${t}:t` }],
      [{ text: '取消', callback_data: 'fg:0:x' }],
    ] },
  });
}

export async function handleForgetCallback(app, cq) {
  const { cfg, db, tg } = app;
  const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const m = /^fg:(\d+):([rtx])$/.exec(cq.data);
  if (!m || cq.message?.chat?.id !== cfg.groupId || !cfg.adminIds.has(cq.from.id)) return answer('无权限');
  const done = (text) => tg.call('editMessageText', { chat_id: cfg.groupId, message_id: cq.message.message_id, text })
    .catch(() => {});
  if (m[2] === 'x') { await answer(); return done('已取消。'); }

  const topicId = Number(m[1]);
  const user = await db.getUserByTopic(topicId);
  if (!user) { await answer(); return done('这个访客的记录已经不存在。'); }
  await db.forgetUser(user.user_id, topicId);
  await answer('已删除');
  if (m[2] === 't') {
    await tg.call('deleteForumTopic', { chat_id: cfg.groupId, message_thread_id: topicId })
      .catch((err) => app.notify(`⚠️ 记录已删除，但删除话题失败：${err.message}`));
    return; // the confirmation message went away with the topic
  }
  return done(`🗑 已删除 ${user.name || user.user_id} 的全部记录；话题保留。`);
}
