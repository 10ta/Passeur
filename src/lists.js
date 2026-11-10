// List topics: a topic in the admin group whose recipients are a registered
// set of guests instead of one guest. Guest topics are the 1-person case and
// keep their own path in admin.js (reply threading, edit sync, inbound).
//
// Budget: one fan-out copies to each member with 1 Bot API call, plus 1 for
// the failure report, so MAX_MEMBERS = 45 stays within the Free
// plan's 50 external subrequests per invocation (albums: copyMessages, same).

import { TgError } from './telegram.js';
import { esc } from './text.js';
import { bufferAlbum } from './relay.js';
import { keepForwardSource, getSetting } from './settings.js';

export const MAX_MEMBERS = 45;
const RECENT = 30;

const short = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

// ---------------------------------------------------------------- panel

async function panel(app, topicId) {
  const list = await app.db.getList(topicId);
  const members = await app.db.listMembers(topicId);
  const inList = new Set(members.map((m) => m.user_id));
  const others = (await app.db.recentGuests(RECENT)).filter((g) => !inList.has(g.user_id));
  const people = [
    ...members.map((m) => ({ ...m, on: true })),
    ...others.map((g) => ({ ...g, on: false })),
  ];
  const button = (p) => ({
    text: `${p.on ? '☑' : '☐'} ${p.blocked ? '⛔' : ''}${short(p.name || String(p.user_id), 16)}`,
    callback_data: `lm:${topicId}:${p.user_id}`,
  });
  const rows = [];
  for (let i = 0; i < people.length; i += 2) rows.push(people.slice(i, i + 2).map(button));
  return {
    text: [
      `📤 名单「${list.name}」：${members.length}/${MAX_MEMBERS} 人`,
      '点名字加入 / 移出（立即保存）。在这个话题里发的消息会发给所有 ☑ 的人（⛔ 已拉黑的除外）。',
      people.length ? '' : '还没有访客。',
    ].join('\n').trim(),
    reply_markup: { inline_keyboard: rows },
  };
}

/** `/newlist <name>`: creates the topic, registers it, posts the panel inside. */
export async function newList(app, msg, name, replyIn) {
  name = short(name.trim() || '群发', 60);
  const topic = await app.tg.call('createForumTopic', { chat_id: app.cfg.groupId, name: `📤 ${name}` });
  await app.db.createList(topic.message_thread_id, name);
  const p = await panel(app, topic.message_thread_id);
  await app.tg.call('sendMessage', { chat_id: app.cfg.groupId, message_thread_id: topic.message_thread_id, ...p });
  if (msg.message_thread_id !== topic.message_thread_id) {
    await replyIn(app, msg, `已创建名单话题「📤 ${esc(name)}」，在里面勾选收件人。`);
  }
}

/** `/list` inside a list topic: posts a fresh panel. */
export async function showPanel(app, topicId) {
  const p = await panel(app, topicId);
  return app.tg.call('sendMessage', { chat_id: app.cfg.groupId, message_thread_id: topicId, ...p });
}

export async function handleListCallback(app, cq) {
  const { cfg, db, tg } = app;
  const answer = (text, alert = false) =>
    tg.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const m = /^lm:(\d+):(\d+)$/.exec(cq.data);
  if (!m || cq.message?.chat?.id !== cfg.groupId || !cfg.adminIds.has(cq.from.id)) return answer('无权限');
  const topicId = Number(m[1]);
  const userId = Number(m[2]);
  if (!(await db.getList(topicId))) return answer('名单已不存在', true);

  const members = await db.listMembers(topicId);
  if (members.some((x) => x.user_id === userId)) {
    await db.removeMember(topicId, userId);
  } else {
    if (members.length >= MAX_MEMBERS) return answer(`每个名单最多 ${MAX_MEMBERS} 人`, true);
    if (!(await db.getUser(userId))) return answer('用户不存在', true);
    await db.addMember(topicId, userId);
  }
  await answer();
  const p = await panel(app, topicId);
  await tg.call('editMessageText', { chat_id: cfg.groupId, message_id: cq.message.message_id, ...p })
    .catch((err) => { if (!(err instanceof TgError && err.notModified)) console.error('panel edit failed', err.message); });
}

// ---------------------------------------------------------------- fan-out

/** Copies an admin's message in a list topic to every member (runs in waitUntil). */
export async function fanOut(app, msg) {
  const { cfg, db } = app;
  const members = (await db.listMembers(msg.message_thread_id)).filter((m) => !m.blocked);
  if (!members.length) {
    return app.tg.call('sendMessage', {
      chat_id: cfg.groupId, message_thread_id: msg.message_thread_id,
      text: '名单是空的，没有发出。发 /list 勾选收件人。',
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    });
  }
  const forward = await keepForwardSource(app, msg, msg.message_thread_id);
  const deliver = (ids) => deliverAll(app, msg, members, ids, forward);
  const onError = (err) => app.notify(`⚠️ 名单群发失败：${err.message}`);
  if (msg.media_group_id) {
    await bufferAlbum(app, cfg.groupId, msg, { group: deliver, single: (id) => deliver([id]) }, onError);
  } else {
    app.waitUntil(deliver([msg.message_id]).catch(onError));
  }
}

async function deliverAll(app, msg, members, ids, forward) {
  const { cfg, tg } = app;
  const method = ids.length > 1 ? (forward ? 'forwardMessages' : 'copyMessages') : (forward ? 'forwardMessage' : 'copyMessage');
  const idParam = ids.length > 1 ? { message_ids: ids } : { message_id: ids[0] };
  let sent = 0;
  const failed = [];
  let stoppedAt = null;
  for (const m of members) {
    try {
      await tg.call(method, { chat_id: m.user_id, from_chat_id: cfg.groupId, ...idParam });
      sent++;
    } catch (err) {
      if (err instanceof TgError && err.code === 429) { stoppedAt = m; break; }
      failed.push(`${m.name}（${err instanceof TgError && err.recipientGone ? '已屏蔽 bot' : '发送失败'}）`);
    }
  }
  if (sent === members.length) return; // success is silent
  console.error(`fan-out: ${sent}/${members.length} delivered`);
  if ((await getSetting(app, 'receipts', msg.message_thread_id)) === 'off') return;
  const lines = [`📤 已发送 ${sent}/${members.length} 人`];
  if (failed.length) lines.push(`未送达：${failed.join('、')}`);
  if (stoppedAt) lines.push(`⚠️ 触发 Telegram 限流，从「${stoppedAt.name}」起未发送，请稍后重发这条。`);
  await tg.call('sendMessage', {
    chat_id: cfg.groupId, message_thread_id: msg.message_thread_id, text: lines.join('\n'),
    reply_parameters: { message_id: ids[0], allow_sending_without_reply: true },
  }).catch((err) => console.error('fan-out report failed', err.message));
}
