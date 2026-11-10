import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  setup, guest, inTopic, inGeneral, cmdEntities, nextMsgId, GROUP, ADMIN1, ADMIN2,
} from './helpers.js';

const cmd = (text) => ({ text, entities: cmdEntities(text) });

// ---------------------------------------------------------------- webhook

test('webhook rejects wrong secret and wrong paths', async () => {
  const { env } = setup();
  const ctx = { waitUntil() {} };
  const req = (path, init) => new Request(`https://x.example${path}`, init);
  assert.equal((await worker.fetch(req('/'), env, ctx)).status, 200);
  assert.equal((await worker.fetch(req('/nope'), env, ctx)).status, 404);
  const bad = await worker.fetch(req('/webhook', { method: 'POST', body: '{}', headers: { 'x-telegram-bot-api-secret-token': 'wrong' } }), env, ctx);
  assert.equal(bad.status, 401);
  const none = await worker.fetch(req('/webhook', { method: 'POST', body: '{}' }), { ...env, WEBHOOK_SECRET: '' }, ctx);
  assert.equal(none.status, 401, 'empty secret must never authorize');
  const ok = await worker.fetch(req('/webhook', { method: 'POST', body: '{"update_id":1}', headers: { 'x-telegram-bot-api-secret-token': 'sekret' } }), env, ctx);
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------- setup mode

test('setup mode: /id works in DM and group, nothing is relayed', async () => {
  const s = setup({ GROUP_ID: '' });
  await s.send(guest(501, cmd('/id')));
  assert.match(s.tg.of('sendMessage')[0].params.text, /501/);
  await s.send(guest(501));
  assert.equal(s.tg.of('createForumTopic').length, 0);
  const g = inGeneral(ADMIN1, cmd('/id'));
  g.message.chat.id = -100777;
  await s.send(g);
  assert.match(s.tg.of('sendMessage').at(-1).params.text, /-100777/);
});

// ---------------------------------------------------------------- guest -> topic

test('first message creates topic + user card, then copies into it', async () => {
  const s = setup();
  const u = guest(601);
  await s.send(u);
  const topic = s.tg.of('createForumTopic');
  assert.equal(topic.length, 1);
  assert.equal(topic[0].params.name, 'Guest601 · 601');
  const card = s.tg.of('sendMessage')[0].params;
  assert.match(card.text, /tg:\/\/user\?id=601/);
  const copy = s.tg.of('copyMessage')[0].params;
  assert.deepEqual([copy.chat_id, copy.from_chat_id, copy.message_id, copy.message_thread_id], [GROUP, 601, u.message.message_id, 500]);
  const map = s.row('SELECT * FROM msg_map WHERE guest_id = 601');
  assert.equal(map.dir, 0);

  s.tg.clear();
  await s.send(guest(601));
  assert.equal(s.tg.of('createForumTopic').length, 0, 'topic is reused');
});

test('concurrent first messages create exactly one topic', async () => {
  const s = setup();
  await Promise.all([s.send(guest(602)), s.send(guest(602)), s.send(guest(602))]);
  assert.equal(s.tg.of('createForumTopic').length, 1);
  assert.equal(s.tg.of('copyMessage').length, 3);
  assert.ok(s.tg.of('copyMessage').every((c) => c.params.message_thread_id === 500));
});

test('guest forwarded content is forwarded (source kept); replies are threaded', async () => {
  const s = setup();
  await s.send(guest(603));
  const topicCopy = s.row('SELECT topic_msg_id FROM msg_map WHERE guest_id = 603').topic_msg_id;
  const first = s.row('SELECT guest_msg_id FROM msg_map WHERE guest_id = 603').guest_msg_id;
  s.tg.clear();
  await s.send(guest(603, { forward_origin: { type: 'channel', chat: { id: -5 } } }));
  assert.equal(s.tg.of('forwardMessage').length, 1);
  await s.send(guest(603, { reply_to_message: { message_id: first } }));
  assert.equal(s.tg.of('copyMessage')[0].params.reply_parameters.message_id, topicCopy);
});

test('deleted topic is recreated and the message retried', async () => {
  const s = setup();
  await s.send(guest(604));
  s.tg.clear();
  s.tg.failNext('copyMessage', 400, 'Bad Request: message thread not found');
  await s.send(guest(604));
  assert.equal(s.tg.of('createForumTopic').length, 1);
  const copies = s.tg.of('copyMessage');
  assert.equal(copies.length, 2);
  assert.equal(copies[1].params.message_thread_id, 501);
  assert.equal(s.row('SELECT topic_id FROM users WHERE user_id = 604').topic_id, 501);
});

test('wrong GROUP_ID: guest is told delivery failed instead of silence', async () => {
  const s = setup();
  s.tg.failNext('createForumTopic', 400, 'Bad Request: chat not found');
  await assert.rejects(s.send(guest(609)));
  const toGuest = s.tg.of('sendMessage').filter((c) => c.params.chat_id === 609);
  assert.equal(toGuest.length, 1);
  assert.match(toGuest[0].params.text, /发送失败/);
  assert.equal(s.row('SELECT topic_id FROM users WHERE user_id = 609').topic_id, null, 'claim released');
});

test('/id and /check in a group that is not GROUP_ID answer anyone, with a hint', async () => {
  const s = setup({ ADMIN_IDS: '' }); // even with wrong admin IDs
  for (const c of ['/id', '/check']) {
    const g = inGeneral(4242, cmd(c));
    g.message.chat.id = -100555;
    await s.send(g);
  }
  const texts = s.tg.of('sendMessage').map((c) => c.params.text);
  assert.equal(texts.length, 2);
  assert.ok(texts.every((t) => t.includes('-100555') && t.includes('GROUP_ID')), texts.join('\n'));
  const other = inGeneral(4242, { text: 'hi' });
  other.message.chat.id = -100555;
  await s.send(other);
  assert.equal(s.tg.calls.length, 2, 'plain messages in other groups stay ignored');
});

test('closed topic is reopened, not duplicated', async () => {
  const s = setup();
  await s.send(guest(608));
  s.tg.clear();
  s.tg.failNext('copyMessage', 400, 'Bad Request: TOPIC_CLOSED');
  await s.send(guest(608));
  assert.equal(s.tg.of('createForumTopic').length, 0);
  assert.equal(s.tg.of('reopenForumTopic')[0].params.message_thread_id, 500);
  assert.equal(s.tg.of('copyMessage').length, 2);
  assert.equal(s.row('SELECT topic_id FROM users WHERE user_id = 608').topic_id, 500);
});

test('unsupported message tells the guest; other failures notify admins via top level', async () => {
  const s = setup();
  await s.send(guest(605));
  s.tg.clear();
  s.tg.failNext('copyMessage', 400, "Bad Request: message can't be copied");
  await s.send(guest(605));
  assert.match(s.tg.of('sendMessage')[0].params.text, /无法转达/);
  s.tg.failNext('copyMessage', 500, 'Internal Server Error');
  await assert.rejects(s.send(guest(605)));
  assert.match(s.tg.of('sendMessage').at(-1).params.text, /发送失败/);
});

test('rate limit drops excess messages and notifies once', async () => {
  const s = setup({ RATE_LIMIT_PER_MIN: '3' });
  for (let i = 0; i < 6; i++) await s.send(guest(606));
  assert.equal(s.tg.of('copyMessage').length, 3);
  assert.equal(s.tg.of('sendMessage').filter((c) => c.params.chat_id === 606).length, 1);
});

test('profile change renames the topic', async () => {
  const s = setup();
  await s.send(guest(607));
  const u = guest(607);
  u.message.from.first_name = 'Renamed';
  await s.send(u);
  assert.equal(s.tg.of('editForumTopic')[0].params.name, 'Renamed · 607');
});

// ---------------------------------------------------------------- captcha

test('captcha: pending message is delivered after the right answer', async () => {
  const s = setup({ VERIFY: '1' });
  const first = guest(701, { text: 'first!' });
  await s.send(first);
  assert.equal(s.tg.of('copyMessage').length, 0);
  const prompt = s.tg.of('sendMessage')[0].params;
  assert.equal(prompt.reply_markup.inline_keyboard[0].length, 4);
  await s.send(guest(701, { text: 'second' })); // not stored, no new prompt
  assert.equal(s.tg.of('sendMessage').length, 1);

  const answer = s.row('SELECT captcha_answer FROM users WHERE user_id = 701').captcha_answer;
  const cb = (n) => ({
    callback_query: { id: 'q', from: { id: 701, first_name: 'Guest701' }, data: `cap:${n}`,
      message: { message_id: 9, chat: { id: 701, type: 'private' } } },
  });
  await s.send(cb(answer === 2 ? 3 : 2)); // wrong
  assert.equal(s.row('SELECT captcha_fails FROM users WHERE user_id = 701').captcha_fails, 1);
  const newAnswer = s.row('SELECT captcha_answer FROM users WHERE user_id = 701').captcha_answer;
  await s.send(cb(newAnswer));
  assert.equal(s.row('SELECT verified FROM users WHERE user_id = 701').verified, 1);
  const copy = s.tg.of('copyMessage');
  assert.equal(copy.length, 1);
  assert.equal(copy[0].params.message_id, first.message.message_id);
});

test('captcha: three wrong answers lock the guest', async () => {
  const s = setup({ VERIFY: '1' });
  await s.send(guest(702));
  for (let i = 0; i < 3; i++) {
    const a = s.row('SELECT captcha_answer FROM users WHERE user_id = 702').captcha_answer;
    await s.send({ callback_query: { id: 'q', from: { id: 702 }, data: `cap:${a + 100}`,
      message: { message_id: 9, chat: { id: 702, type: 'private' } } } });
  }
  const row = s.row('SELECT * FROM users WHERE user_id = 702');
  assert.ok(row.locked_until > Date.now() / 1000);
  assert.equal(row.verified, 0);
  s.tg.clear();
  await s.send(guest(702));
  assert.match(s.tg.of('sendMessage')[0].params.text, /分钟后再试/);
});

// ---------------------------------------------------------------- topic -> guest

test('both admins can reply from the topic; replies map back', async () => {
  const s = setup();
  const g = guest(801);
  await s.send(g);
  const topicCopy = s.row('SELECT topic_msg_id FROM msg_map WHERE guest_id = 801').topic_msg_id;
  s.tg.clear();
  await s.send(inTopic(500, ADMIN1));
  await s.send(inTopic(500, ADMIN2, { reply_to_message: { message_id: topicCopy } }));
  const copies = s.tg.of('copyMessage');
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.params.chat_id === 801 && c.params.from_chat_id === GROUP));
  assert.equal(copies[1].params.reply_parameters.message_id, g.message.message_id);
});

test('reply to the topic root is not treated as a reply', async () => {
  const s = setup();
  await s.send(guest(802));
  s.tg.clear();
  await s.send(inTopic(500, ADMIN1, { reply_to_message: { message_id: 500 } }));
  assert.equal(s.tg.of('copyMessage')[0].params.reply_parameters, undefined);
});

test('non-admin members, anonymous admins, service messages and General chatter are not relayed', async () => {
  const s = setup();
  await s.send(guest(803));
  s.tg.clear();
  await s.send(inTopic(500, 33));
  await s.send(inTopic(500, ADMIN1, { text: undefined, forum_topic_edited: { name: 'x' } }));
  await s.send(inGeneral(ADMIN1));
  assert.equal(s.tg.calls.length, 0);
  await s.send(inTopic(500, 1087968824, { sender_chat: { id: GROUP } }));
  assert.equal(s.tg.of('copyMessage').length, 0);
  assert.match(s.tg.of('sendMessage')[0].params.text, /匿名/);
});

test('channel posts: copy by default, forward when FORWARD_CHANNEL_POSTS=1', async () => {
  for (const [flag, method] of [['0', 'copyMessage'], ['1', 'forwardMessage']]) {
    const s = setup({ FORWARD_CHANNEL_POSTS: flag });
    await s.send(guest(804));
    s.tg.clear();
    await s.send(inTopic(500, ADMIN1, { forward_origin: { type: 'channel', chat: { id: -9 } } }));
    assert.equal(s.tg.of(method).length, 1, `${flag} -> ${method}`);
    s.tg.clear();
    await s.send(inTopic(500, ADMIN1, { forward_origin: { type: 'user', sender_user: { id: 5 } } }));
    assert.equal(s.tg.of('copyMessage').length, 1, 'non-channel origins are always copied');
  }
});

test('guest who blocked the bot: admin sees a notice in the topic', async () => {
  const s = setup();
  await s.send(guest(805));
  s.tg.clear();
  s.tg.failNext('copyMessage', 403, 'Forbidden: bot was blocked by the user');
  await s.send(inTopic(500, ADMIN1));
  const notice = s.tg.of('sendMessage')[0].params;
  assert.equal(notice.message_thread_id, 500);
  assert.match(notice.text, /屏蔽/);
});

// ---------------------------------------------------------------- commands

test('/block silences the guest; /unblock restores', async () => {
  const s = setup();
  await s.send(guest(901));
  await s.send(inTopic(500, ADMIN1, cmd('/block')));
  s.tg.clear();
  await s.send(guest(901));
  assert.equal(s.tg.calls.length, 0);
  await s.send(inTopic(500, ADMIN1));
  assert.match(s.tg.of('sendMessage')[0].params.text, /已被拉黑/);
  await s.send(inTopic(500, ADMIN1, cmd('/unblock')));
  s.tg.clear();
  await s.send(guest(901));
  assert.equal(s.tg.of('copyMessage').length, 1);
});

test('/info, /stats, /blocked, /check, unknown command', async () => {
  const s = setup();
  await s.send(guest(902));
  s.tg.clear();
  await s.send(inTopic(500, ADMIN1, cmd('/info')));
  await s.send(inGeneral(ADMIN1, cmd('/stats')));
  await s.send(inGeneral(ADMIN1, cmd('/blocked')));
  await s.send(inGeneral(ADMIN1, cmd('/check')));
  await s.send(inGeneral(ADMIN1, cmd('/info')));
  await s.send(inGeneral(ADMIN1, cmd('/nope@passeur_bot')));
  const texts = s.tg.of('sendMessage').map((c) => c.params.text);
  assert.match(texts[0], /<code>902<\/code>/);
  assert.match(texts[1], /用户 1/);
  assert.match(texts[2], /没有被拉黑/);
  assert.ok(!texts[3].includes('⚠️'), texts[3]);
  assert.match(texts[4], /只能在用户的话题/);
  assert.match(texts[5], /未知命令/);
  assert.equal(s.tg.of('copyMessage').length, 0, 'commands are never relayed');
});

test('/check reports anonymous admins and missing permissions', async () => {
  const s = setup();
  const orig = s.tg.call;
  s.tg.call = async (m, p) => {
    if (m === 'getChatMember' && p.user_id === ADMIN2) return { status: 'administrator', is_anonymous: true };
    if (m === 'getChatMember' && p.user_id === 999) return { status: 'administrator', can_manage_topics: false };
    return orig(m, p);
  };
  await s.send(inGeneral(ADMIN1, cmd('/check')));
  const text = s.tg.of('sendMessage')[0].params.text;
  assert.match(text, /管理话题/);
  assert.match(text, new RegExp(`${ADMIN2}.*保持匿名`));
});

// ---------------------------------------------------------------- edits

test('edits are mirrored in both directions', async () => {
  const s = setup();
  const g = guest(1001, { text: 'v1' });
  await s.send(g);
  const topicCopy = s.row('SELECT topic_msg_id FROM msg_map WHERE guest_id = 1001').topic_msg_id;
  await s.send({ edited_message: { ...g.message, text: 'v2' } });
  const e1 = s.tg.of('editMessageText')[0].params;
  assert.deepEqual([e1.chat_id, e1.message_id, e1.text], [GROUP, topicCopy, 'v2']);

  const a = inTopic(500, ADMIN1, { text: 'a1' });
  await s.send(a);
  const guestCopy = s.row('SELECT guest_msg_id FROM msg_map WHERE topic_msg_id = ?', a.message.message_id).guest_msg_id;
  await s.send({ edited_message: { ...a.message, caption: 'c2', text: undefined } });
  const e2 = s.tg.of('editMessageCaption')[0].params;
  assert.deepEqual([e2.chat_id, e2.message_id, e2.caption], [1001, guestCopy, 'c2']);
});

// ---------------------------------------------------------------- albums

test('album is sent once as a group; a late item goes alone', async () => {
  const s = setup();
  await s.send(guest(1101));
  s.tg.clear();
  const ids = [nextMsgId(), nextMsgId(), nextMsgId()];
  const item = (id) => guest(1101, { message_id: id, media_group_id: 'G1', text: undefined, photo: [{}] });
  // Deliver out of order, concurrently.
  await Promise.all([s.send(item(ids[2])), s.send(item(ids[0])), s.send(item(ids[1]))]);
  assert.equal(s.tg.of('copyMessages').length, 0, 'leader waits');
  await s.flush();
  const batch = s.tg.of('copyMessages');
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].params.message_ids, ids);
  assert.equal(s.rows('SELECT * FROM msg_map WHERE guest_id = 1101').length, 4);

  await s.send(item(nextMsgId()));
  await s.flush();
  assert.equal(s.tg.of('copyMessages').length, 1);
  assert.equal(s.tg.of('copyMessage').length, 1, 'late item sent alone');
});

test('admin album from topic goes to guest as a group; failure is reported in topic', async () => {
  const s = setup();
  await s.send(guest(1102));
  s.tg.clear();
  const ids = [nextMsgId(), nextMsgId()];
  for (const id of ids) await s.send(inTopic(500, ADMIN1, { message_id: id, media_group_id: 'A1', text: undefined }));
  await s.flush();
  assert.deepEqual(s.tg.of('copyMessages')[0].params.message_ids, ids);
  assert.equal(s.tg.of('copyMessages')[0].params.chat_id, 1102);

  s.tg.clear();
  s.tg.failNext('copyMessages', 403, 'Forbidden: bot was blocked by the user');
  for (const id of [nextMsgId(), nextMsgId()]) await s.send(inTopic(500, ADMIN1, { message_id: id, media_group_id: 'A2', text: undefined }));
  await s.flush();
  assert.match(s.tg.of('sendMessage')[0].params.text, /屏蔽/);
});

// ---------------------------------------------------------------- broadcast + cron

test('broadcast runs in batches of 40, skips blocked/unverified, and reports', async () => {
  const s = setup();
  const insert = s.d1.raw.prepare('INSERT INTO users (user_id, name, verified, blocked, created_at) VALUES (?, ?, ?, ?, 0)');
  for (let i = 1; i <= 45; i++) insert.run(2000 + i, `u${i}`, 1, 0);
  insert.run(3001, 'blocked', 1, 1);
  insert.run(3002, 'unverified', 0, 0);
  const src = inGeneral(ADMIN1);
  await s.send(inGeneral(ADMIN1, { ...cmd('/broadcast'), reply_to_message: { message_id: src.message.message_id } }));
  await s.flush();
  assert.equal(s.tg.of('copyMessage').length, 40);

  await s.send(inGeneral(ADMIN1, { ...cmd('/broadcast'), reply_to_message: { message_id: 1 } }));
  assert.match(s.tg.of('sendMessage').at(-1).params.text, /进行中/);

  const ctx = { waitUntil() {} };
  s.tg.failNext('copyMessage', 403, 'Forbidden: bot was blocked by the user');
  // Run the cron through the real entry point, sharing the fake Telegram.
  const { createApp } = await import('../src/index.js');
  const { runBroadcastBatch } = await import('../src/broadcast.js');
  const app = createApp(s.env, ctx, { tg: s.tg });
  await runBroadcastBatch(app);
  assert.equal(s.tg.of('copyMessage').length, 45);
  const job = s.row('SELECT * FROM broadcasts');
  assert.deepEqual([job.sent, job.failed, job.done], [44, 1, 1]);
  assert.match(s.tg.of('sendMessage').at(-1).params.text, /广播完成/);
});

test('broadcast stops on 429 without skipping the user', async () => {
  const s = setup();
  const insert = s.d1.raw.prepare('INSERT INTO users (user_id, name, verified, created_at) VALUES (?, ?, 1, 0)');
  for (let i = 1; i <= 3; i++) insert.run(4000 + i, `u${i}`);
  s.tg.failNext('copyMessage', 429, 'Too Many Requests', (p) => p.chat_id === 4002, { retry_after: 5 });
  await s.send(inGeneral(ADMIN1, { ...cmd('/broadcast'), reply_to_message: { message_id: 1 } }));
  await s.flush();
  let job = s.row('SELECT * FROM broadcasts');
  assert.deepEqual([job.cursor, job.sent, job.done], [4001, 1, 0]);
  const { runBroadcastBatch } = await import('../src/broadcast.js');
  await runBroadcastBatch(s.app);
  job = s.row('SELECT * FROM broadcasts');
  assert.deepEqual([job.cursor, job.sent, job.done], [4003, 3, 1]);
});

test('cron cleanup removes expired rows only at 03:00 UTC', async () => {
  const s = setup({ RETENTION_DAYS: '1' });
  s.d1.raw.exec(`INSERT INTO msg_map VALUES (1, 1, 1, 0, 0), (1, 2, 2, 0, ${Math.floor(Date.now() / 1000)})`);
  s.d1.raw.exec(`INSERT INTO album_items VALUES ('orphan', 1, 0)`);
  const ctx = { waitUntil() {} };
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 0, 1, 4, 0) }, s.env, ctx);
  assert.equal(s.rows('SELECT * FROM msg_map').length, 2);
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 0, 1, 3, 0) }, s.env, ctx);
  assert.equal(s.rows('SELECT * FROM msg_map').length, 1);
  assert.equal(s.rows('SELECT * FROM album_items').length, 0);
});

// ---------------------------------------------------------------- admin DM

test('admins who DM the bot are pointed to the group, not relayed', async () => {
  const s = setup();
  await s.send(guest(ADMIN1));
  assert.equal(s.tg.of('createForumTopic').length, 0);
  assert.match(s.tg.of('sendMessage')[0].params.text, /管理员/);
});

// ---------------------------------------------------------------- list topics

/** Creates guests (each gets a guest topic) and a list topic; returns its thread id. */
async function listSetup(s, guestIds, name = '客户') {
  for (const id of guestIds) await s.send(guest(id));
  s.tg.clear();
  await s.send(inGeneral(ADMIN1, { text: `/newlist ${name}`, entities: cmdEntities('/newlist') }));
  const topic = s.tg.of('createForumTopic')[0];
  assert.equal(topic.params.name, `📤 ${name}`);
  return 500 + guestIds.length; // fake thread ids are sequential
}
const listCb = (s, topicId, userId, from = ADMIN1) => s.send({ callback_query: {
  id: 'q', from: { id: from }, data: `lm:${topicId}:${userId}`,
  message: { message_id: 8888, chat: { id: GROUP, type: 'supergroup' } } } });

test('/newlist creates a list topic with a panel inside; /list re-posts it', async () => {
  const s = setup();
  const t = await listSetup(s, [2101, 2102]);
  const panel = s.tg.of('sendMessage').find((c) => c.params.message_thread_id === t);
  assert.match(panel.params.text, /名单「客户」：0\/45/);
  assert.deepEqual(panel.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).sort(),
    [`lm:${t}:2101`, `lm:${t}:2102`]);
  assert.match(s.tg.of('sendMessage').at(-1).params.text, /已创建名单话题/);
  s.tg.clear();
  await s.send(inTopic(t, ADMIN1, cmd('/list')));
  assert.equal(s.tg.of('sendMessage')[0].params.message_thread_id, t);
  await s.send(inGeneral(ADMIN1, cmd('/list')));
  assert.match(s.tg.of('sendMessage')[1].params.text, /名单话题里发 \/list/);
});

test('panel toggles membership in D1 and re-renders; non-admins are refused', async () => {
  const s = setup();
  const t = await listSetup(s, [2201, 2202]);
  await listCb(s, t, 2201);
  assert.ok(s.row('SELECT 1 AS x FROM list_members WHERE topic_id = ? AND user_id = 2201', t));
  const edit = s.tg.of('editMessageText').at(-1).params;
  assert.match(edit.text, /1\/45/);
  assert.equal(edit.reply_markup.inline_keyboard.flat()[0].text, '☑ Guest2201', 'members listed first');
  await listCb(s, t, 2201);
  assert.equal(s.rows('SELECT * FROM list_members').length, 0, 'second tap removes');
  await listCb(s, t, 2202, 33);
  assert.equal(s.tg.of('answerCallbackQuery').at(-1).params.text, '无权限');
  assert.equal(s.rows('SELECT * FROM list_members').length, 0);
});

test('list is capped at 45 members', async () => {
  const s = setup();
  const t = await listSetup(s, [2301]);
  const ins = s.d1.raw.prepare('INSERT INTO users (user_id, name, verified, topic_id, created_at) VALUES (?, ?, 1, ?, 0)');
  for (let i = 0; i < 46; i++) ins.run(3000 + i, `u${i}`, 9000 + i);
  for (let i = 0; i < 45; i++) s.d1.raw.prepare('INSERT INTO list_members VALUES (?, ?)').run(t, 3000 + i);
  await listCb(s, t, 3045);
  const a = s.tg.of('answerCallbackQuery').at(-1).params;
  assert.equal(a.show_alert, true);
  assert.match(a.text, /最多 45/);
});

test('a message in a list topic goes to every non-blocked member; 👌 on success', async () => {
  const s = setup();
  const t = await listSetup(s, [2401, 2402, 2403]);
  for (const id of [2401, 2402, 2403]) await listCb(s, t, id);
  s.d1.raw.exec('UPDATE users SET blocked = 1 WHERE user_id = 2403');
  s.tg.clear();
  const m = inTopic(t, ADMIN2, { text: 'news for everyone' });
  await s.send(m);
  await s.flush();
  const copies = s.tg.of('copyMessage');
  assert.deepEqual(copies.map((c) => c.params.chat_id).sort(), [2401, 2402]);
  assert.ok(copies.every((c) => c.params.from_chat_id === GROUP && c.params.message_id === m.message.message_id));
  assert.equal(s.tg.of('setMessageReaction')[0].params.message_id, m.message.message_id);
  assert.equal(s.tg.of('sendMessage').length, 0, 'no report when all succeed');
  assert.equal(s.rows('SELECT * FROM msg_map WHERE topic_msg_id = ?', m.message.message_id).length, 0);
});

test('list fan-out reports 403 and stops at 429; empty list is refused; commands are not sent', async () => {
  const s = setup();
  const t = await listSetup(s, [2501, 2502, 2503]);
  s.tg.clear();
  await s.send(inTopic(t, ADMIN1));
  assert.match(s.tg.of('sendMessage')[0].params.text, /名单是空的/);
  for (const id of [2501, 2502, 2503]) await listCb(s, t, id);
  const order = s.rows('SELECT u.user_id FROM list_members m JOIN users u USING (user_id) WHERE m.topic_id = ? ORDER BY u.name', t).map((r) => r.user_id);
  s.tg.failNext('copyMessage', 403, 'Forbidden: bot was blocked by the user', (p) => p.chat_id === order[0]);
  s.tg.failNext('copyMessage', 429, 'Too Many Requests', (p) => p.chat_id === order[2], { retry_after: 3 });
  s.tg.clear();
  await s.send(inTopic(t, ADMIN1));
  await s.flush();
  const report = s.tg.of('sendMessage').at(-1).params;
  assert.equal(report.message_thread_id, t);
  assert.match(report.text, /已发送 1\/3/);
  assert.match(report.text, /已屏蔽 bot/);
  assert.match(report.text, /限流/);
  assert.equal(s.tg.of('setMessageReaction').length, 0);
  s.tg.clear();
  await s.send(inTopic(t, ADMIN1, cmd('/stats')));
  assert.equal(s.tg.of('copyMessage').length, 0);
});

test('an album in a list topic goes to each member as one group', async () => {
  const s = setup();
  const t = await listSetup(s, [2601, 2602]);
  for (const id of [2601, 2602]) await listCb(s, t, id);
  s.tg.clear();
  const ids = [nextMsgId(), nextMsgId(), nextMsgId()];
  await Promise.all(ids.map((id) => s.send(inTopic(t, ADMIN1, { message_id: id, media_group_id: 'L1', text: undefined }))));
  await s.flush();
  const groups = s.tg.of('copyMessages');
  assert.deepEqual(groups.map((c) => c.params.chat_id).sort(), [2601, 2602]);
  assert.ok(groups.every((c) => JSON.stringify(c.params.message_ids) === JSON.stringify(ids)));
  assert.equal(s.tg.of('setMessageReaction').length, 1);
});

test('guest topics are unaffected and a list topic never receives guest messages', async () => {
  const s = setup();
  const t = await listSetup(s, [2701]);
  await listCb(s, t, 2701);
  s.tg.clear();
  await s.send(guest(2701));
  assert.equal(s.tg.of('copyMessage')[0].params.message_thread_id, 500, 'goes to the guest topic');
  s.tg.clear();
  await s.send(inTopic(500, ADMIN1));
  assert.equal(s.tg.of('copyMessage').length, 1, 'guest topic still 1:1');
});

test('a full 45-member fan-out stays within 50 Bot API calls', async () => {
  const s = setup();
  const t = await listSetup(s, [2801]);
  const ins = s.d1.raw.prepare('INSERT INTO users (user_id, name, verified, topic_id, created_at) VALUES (?, ?, 1, ?, 0)');
  for (let i = 0; i < 45; i++) {
    ins.run(5000 + i, `m${i}`, 8000 + i);
    s.d1.raw.prepare('INSERT INTO list_members VALUES (?, ?)').run(t, 5000 + i);
  }
  s.tg.clear();
  await s.send(inTopic(t, ADMIN1));
  await s.flush();
  assert.equal(s.tg.of('copyMessage').length, 45);
  assert.ok(s.tg.calls.length <= 50, `calls: ${s.tg.calls.length}`);
});
