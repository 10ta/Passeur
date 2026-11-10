// The admin forum group: relay topic messages to guests, commands, edits.

import { DIR_OUT } from './db.js';
import { TgError } from './telegram.js';
import { parseCommand } from './commands.js';
import { sendSingle, sendAlbumItem, syncEdit } from './relay.js';
import { esc, userCard, HELP, displayName } from './text.js';
import { runBroadcastBatch } from './broadcast.js';
import { newList, showPanel, fanOut } from './lists.js';
import { showSettings, keepForwardSource, rememberAdmin, getSetting } from './settings.js';
import { markAnswered } from './status.js';
import { startForget } from './forget.js';

const SERVICE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo',
  'pinned_message', 'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed',
  'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden',
  'video_chat_started', 'video_chat_ended', 'video_chat_scheduled', 'video_chat_participants_invited',
  'message_auto_delete_timer_changed', 'migrate_to_chat_id', 'migrate_from_chat_id',
  'boost_added', 'chat_background_set', 'write_access_allowed',
];
const isService = (msg) => SERVICE_KEYS.some((k) => k in msg);
/** Admin-only notes inside a topic: text or caption starting with `//`. */
export const isInternalNote = (msg) => /^\s*\/\//.test(msg.text ?? msg.caption ?? '');

/** Replies inside the same topic (or General) as `msg`. */
export function replyIn(app, msg, text, extra = {}) {
  const p = {
    chat_id: msg.chat.id,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
    ...extra,
  };
  if (msg.is_topic_message && msg.message_thread_id) p.message_thread_id = msg.message_thread_id;
  return app.tg.call('sendMessage', p);
}

export async function handleGroupMessage(app, msg) {
  const { cfg, db } = app;
  const cmd = parseCommand(msg);
  const isAdmin = Boolean(msg.from && cfg.adminIds.has(msg.from.id));

  if (msg.chat.id !== cfg.groupId) {
    // Setup helper. Answers anyone (ADMIN_IDS may be wrong too); a group's own ID is no secret to its members.
    if (cmd?.name === 'id' || cmd?.name === 'check') {
      await replyIn(app, msg, [
        `Chat ID: <code>${msg.chat.id}</code>`,
        cfg.groupId
          ? '⚠️ 这不是 GROUP_ID 配置的群。若这就是管理群，把上面的 ID 填进 .env 的 GROUP_ID，再运行 ./update.sh。'
          : 'GROUP_ID 还没设置：把上面的 ID 填进 .env，再运行 ./update.sh。',
      ].join('\n'));
    }
    return;
  }
  if (msg.sender_chat?.id === msg.chat.id) {
    // "Remain anonymous" admin: the real sender is hidden, so we cannot authorize it.
    await replyIn(app, msg, '⚠️ 匿名管理员发的消息无法识别身份，未转达。请在群管理员设置里关闭“保持匿名”。');
    return;
  }
  // A list topic renamed in Telegram: keep the menus in step (the topic id is what matters).
  if (msg.forum_topic_edited?.name && msg.is_topic_message && (await db.getList(msg.message_thread_id))) {
    await db.renameList(msg.message_thread_id, msg.forum_topic_edited.name.replace(/^📤\s*/u, '') || msg.forum_topic_edited.name);
    return;
  }
  if (!isAdmin || msg.from.is_bot || isService(msg)) return;
  await rememberAdmin(app, msg.from); // for hiding privacy-protected forwards from admins

  const threadId = msg.is_topic_message ? msg.message_thread_id : null;
  if (cmd) return handleCommand(app, msg, cmd, threadId);
  if (!threadId) return; // chatter in General stays in the group
  if (isInternalNote(msg)) return; // `// …` stays in the topic, in guest and list topics alike

  const user = await db.getUserByTopic(threadId);
  if (!user) {
    // Not a guest topic: a list topic fans out to its members; any other topic is the admins' own.
    if (await db.getList(threadId)) await fanOut(app, msg);
    return;
  }
  if (user.blocked) {
    await replyIn(app, msg, '⛔ 该用户已被拉黑，消息未发送。/unblock 后才能联系。');
    return;
  }
  await relayToGuest(app, msg, user);
}

async function relayToGuest(app, msg, user) {
  const { cfg, db } = app;
  let replyTo;
  const r = msg.reply_to_message;
  // In forum topics every message "replies" to the topic root; ignore that.
  if (r && r.message_id !== msg.message_thread_id) {
    replyTo = (await db.mapByTopicMsg(r.message_id))?.guest_msg_id;
  }
  const route = {
    fromChat: cfg.groupId,
    toChat: user.user_id,
    forward: await keepForwardSource(app, msg, user.topic_id),
    replyTo,
    mapRow: (src, dst) => ({ guestId: user.user_id, guestMsgId: dst, topicMsgId: src, dir: DIR_OUT }),
    onSent: () => markAnswered(app, user),
  };
  const onError = (err) => reportDelivery(app, msg, err);
  try {
    if (msg.media_group_id) await sendAlbumItem(app, route, msg, onError);
    else await sendSingle(app, route, msg.message_id);
  } catch (err) {
    await onError(err);
  }
}

async function reportDelivery(app, msg, err) {
  console.error('relay to guest failed', err.message);
  if ((await getSetting(app, 'receipts', msg.message_thread_id)) === 'off') return;
  let text;
  if (err instanceof TgError && err.recipientGone) text = '⚠️ 未送达：对方已屏蔽 bot 或已注销账号。';
  else if (err instanceof TgError && err.code === 429) text = `⚠️ 未送达：触发 Telegram 限流，请 ${err.parameters.retry_after ?? '稍'} 秒后重发。`;
  else if (err instanceof TgError && /can't be (copied|forwarded)|protected/i.test(err.description)) text = '⚠️ 未送达：这条消息无法复制（受保护内容或不支持的类型）。';
  else text = `⚠️ 未送达：${esc(err.message)}`;
  await replyIn(app, msg, text).catch((e) => console.error('report failed', e.message));
}

// ---------------------------------------------------------------------------
// Commands

async function handleCommand(app, msg, cmd, threadId) {
  const { db } = app;
  const user = threadId ? await db.getUserByTopic(threadId) : null;
  const needUser = () => replyIn(app, msg, '这个命令只能在用户的话题里用。');

  switch (cmd.name) {
    case 'start':
    case 'help':
      return replyIn(app, msg, HELP);
    case 'id':
      return replyIn(app, msg, `Chat ID: <code>${msg.chat.id}</code>${threadId ? `\nTopic ID: <code>${threadId}</code>` : ''}`);
    case 'info': {
      if (!user) return needUser();
      const from = { id: user.user_id, first_name: user.name, username: user.username };
      return replyIn(app, msg, userCard(from, user));
    }
    case 'block':
      if (!user) return needUser();
      await db.updateUser(user.user_id, { blocked: 1 });
      return replyIn(app, msg, '⛔ 已拉黑。对方的消息将被静默丢弃。');
    case 'forget':
      if (!user) return needUser();
      return startForget(app, msg, user, replyIn);
    case 'unblock':
      if (!user) return needUser();
      await db.updateUser(user.user_id, { blocked: 0 });
      return replyIn(app, msg, '✅ 已解除拉黑。');
    case 'blocked': {
      const rows = await db.listBlocked(50);
      if (!rows.length) return replyIn(app, msg, '没有被拉黑的用户。');
      return replyIn(app, msg, rows.map((r) =>
        `• ${esc(r.name)}${r.username ? ` @${esc(r.username)}` : ''} — <code>${r.user_id}</code>`).join('\n'));
    }
    case 'stats': {
      const s = await db.stats();
      return replyIn(app, msg, `用户 ${s.users} · 已验证 ${s.verified} · 已拉黑 ${s.blocked}`);
    }
    case 'broadcast': {
      const src = msg.reply_to_message;
      if (threadId || !src) {
        return replyIn(app, msg, '在 General 里回复要广播的那条消息，再发 /broadcast。');
      }
      if (await db.activeBroadcast()) return replyIn(app, msg, '已有广播在进行中，可先 /cancel。');
      await db.createBroadcast(src.message_id);
      await replyIn(app, msg, '📣 已开始广播：每批 40 人，之后每 5 分钟一批。完成后会在这里通知。');
      app.waitUntil(runBroadcastBatch(app).catch((err) => console.error('broadcast batch failed', err.message)));
      return;
    }
    case 'settings':
      return showSettings(app, msg, threadId);
    case 'newlist':
      return newList(app, msg, cmd.args, replyIn);
    case 'list':
      if (threadId && (await db.getList(threadId))) return showPanel(app, threadId);
      return replyIn(app, msg, '在名单话题里发 /list；还没有名单就先 /newlist 名字。');
    case 'cancel': {
      const n = await db.cancelBroadcasts();
      return replyIn(app, msg, n ? '已取消广播。' : '没有进行中的广播。');
    }
    case 'check':
      return replyIn(app, msg, await selfCheck(app));
    default:
      return replyIn(app, msg, '未知命令，/help 查看可用命令。');
  }
}

/** Verifies group and admin setup; returns an HTML report. */
async function selfCheck(app) {
  const { cfg, tg } = app;
  const lines = [];
  const ok = (cond, good, bad) => lines.push(cond ? `✅ ${good}` : `⚠️ ${bad}`);
  const botId = Number.parseInt(cfg.token.split(':')[0], 10);

  const chat = await tg.call('getChat', { chat_id: cfg.groupId }).catch(() => null);
  ok(chat?.is_forum, '群已开启话题 (Topics)', '群未开启话题：群设置 → Topics 打开');

  const me = await tg.call('getChatMember', { chat_id: cfg.groupId, user_id: botId }).catch(() => null);
  ok(me?.status === 'administrator', 'bot 是管理员', 'bot 不是管理员');
  ok(me?.can_manage_topics, 'bot 有“管理话题”权限', 'bot 缺少“管理话题”权限');

  for (const id of cfg.adminIds) {
    const m = await tg.call('getChatMember', { chat_id: cfg.groupId, user_id: id }).catch(() => null);
    if (m?.user) await rememberAdmin(app, m.user).catch(() => {});
    const inGroup = m && ['creator', 'administrator', 'member', 'restricted'].includes(m.status);
    if (!inGroup) { lines.push(`⚠️ 管理员 <code>${id}</code> 不在群里`); continue; }
    const who = m.user ? `<code>${id}</code>（${esc(displayName(m.user))}）` : `<code>${id}</code>`;
    ok(!m.is_anonymous, `管理员 ${who}已就绪`, `管理员 ${who}开着“保持匿名”，消息会无法识别`);
  }
  return lines.join('\n');
}

export async function handleGroupEdit(app, msg) {
  const { cfg, db } = app;
  if (msg.chat.id !== cfg.groupId || !msg.from || !cfg.adminIds.has(msg.from.id)) return;
  const map = await db.mapByTopicMsg(msg.message_id);
  if (!map || map.dir !== DIR_OUT) return;
  await syncEdit(app, map.guest_id, map.guest_msg_id, msg);
}
