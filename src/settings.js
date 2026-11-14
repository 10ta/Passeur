// Runtime settings: one registry, four layers.
//   topic row (t:<id>) -> global row (g) -> .env -> built-in default
// The /settings panel writes the first two layers; "默认" deletes the row so
// the next layer shows through. To add a setting, add one entry to SETTINGS
// and read it with getSetting(app, key, topicId?).

import { TgError } from './telegram.js';
import { esc, displayName } from './text.js';

export const SETTINGS = [
  {
    key: 'forward_source', label: '转发来源', env: 'FORWARD_SOURCE', def: 'all', scopes: ['global', 'topic'],
    options: [['all', '保留'], ['channel', '仅频道'], ['none', '隐藏']],
    help: '转发来的消息发给访客时，是否保留“转发自…”。来源是任一管理员账号（含开了转发隐私的）、本群或 bot 自己时，总是隐藏。',
  },
  {
    key: 'receipts', label: '送达回执', env: 'RECEIPTS', def: 'fail', scopes: ['global', 'topic'],
    options: [['fail', '仅失败时提醒'], ['off', '不提醒']],
    legacy: { 1: 'fail', true: 'fail', on: 'fail', 0: 'off', false: 'off' }, // values from the earlier 👌/👀 version
    help: '发送成功不打扰；发送失败时在话题里回一条说明原因。「不提醒」时失败也只记日志。',
  },
  {
    key: 'list_mirror', label: '群发抄送', env: 'LIST_MIRROR', def: 'all', scopes: ['global', 'topic'], sessions: 'list',
    options: [['all', '全部抄送'], ['reply', '仅回复时补上'], ['off', '关']],
    help: '群发后在每个收件人的话题里转发一份（显示“转发自 你”）。「仅回复时补上」：谁回复了才补进谁的话题。「关」：不抄送。',
  },
  {
    key: 'topic_status', label: '话题状态图标', env: 'TOPIC_STATUS', def: '1', scopes: ['global'], flag: true,
    options: [['1', '开'], ['0', '关']],
    help: '访客发来消息后，他的话题显示“待回复”图标，你的回复送达后恢复。侧边栏一眼看出谁在等。',
  },
  {
    key: 'verify', label: '新访客验证', env: 'VERIFY', def: '1', scopes: ['global'], flag: true,
    options: [['1', '开'], ['0', '关']],
    help: '新访客首次发消息前要点一道算术题。',
  },
  {
    key: 'rate_limit', label: '访客限速', env: 'RATE_LIMIT_PER_MIN', def: '20', scopes: ['global'],
    options: [['10', '10 条/分'], ['20', '20 条/分'], ['60', '60 条/分'], ['0', '不限']],
    help: '每位访客每分钟最多转达的消息数。',
  },
  {
    key: 'retention_days', label: '消息对应保留', env: 'RETENTION_DAYS', def: '90', scopes: ['global'],
    options: [['30', '30 天'], ['90', '90 天'], ['365', '365 天']],
    help: '回复挂接和编辑同步用的消息对应关系保留多久。',
  },
];
const BY_KEY = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

const FLAG_TRUE = ['1', 'true', 'yes', 'on'];
const FLAG_FALSE = ['0', 'false', 'no', 'off'];

/** Normalized .env value for a setting, or null when unset/invalid. */
function envValue(env, def) {
  let raw = String(env[def.env] ?? '').trim().toLowerCase();
  if (def.key === 'forward_source' && !raw && FLAG_TRUE.includes(String(env.FORWARD_CHANNEL_POSTS ?? '').trim().toLowerCase())) {
    raw = 'channel'; // legacy key from the first version; "0" there was just the old default, so it is ignored
  }
  if (!raw) return null;
  if (def.legacy?.[raw]) raw = def.legacy[raw];
  if (def.flag) return FLAG_TRUE.includes(raw) ? '1' : FLAG_FALSE.includes(raw) ? '0' : null;
  if (def.options.some(([v]) => v === raw)) return raw;
  return /^\d+$/.test(raw) && def.key !== 'forward_source' ? raw : null; // e.g. RATE_LIMIT_PER_MIN=15
}

const scopeId = (topicId) => (topicId ? `t:${topicId}` : 'g');
const ADMIN_SCOPE = 'a'; // settings rows: key = admin user id, value = display name

/** Records an admin's current display name; writes only when it changed. */
export function rememberAdmin(app, user) {
  return app.db.upsertSetting(ADMIN_SCOPE, String(user.id), displayName(user));
}

const sameName = (a, b) => String(a ?? '').normalize('NFC').trim() === String(b ?? '').normalize('NFC').trim();

/**
 * Whether a privacy-hidden forward name belongs to an admin. Names are kept
 * from admins' own messages, DMs and /check; any admin still unknown is looked
 * up once here (getChatMember works for members and for accounts that left).
 */
async function isAdminName(app, name, sender) {
  if (sender && sameName(displayName(sender), name)) return true;
  const known = await app.db.getSettings(ADMIN_SCOPE);
  if (Object.values(known).some((n) => sameName(n, name))) return true;
  for (const id of app.cfg.adminIds) {
    if (known[String(id)] != null) continue;
    const m = await app.tg.call('getChatMember', { chat_id: app.cfg.groupId, user_id: id }).catch(() => null);
    if (!m?.user) continue;
    await rememberAdmin(app, m.user).catch(() => {});
    if (sameName(displayName(m.user), name)) return true;
  }
  return false;
}

/** Rows of one scope, read once per request. */
function scopeRows(app, scope) {
  app.settingsCache ??= new Map();
  if (!app.settingsCache.has(scope)) app.settingsCache.set(scope, app.db.getSettings(scope));
  return app.settingsCache.get(scope);
}

/** Effective value and where it came from: 'topic' | 'global' | 'env' | 'default'. */
export async function resolveSetting(app, key, topicId) {
  const def = BY_KEY[key];
  const norm = (v) => def.legacy?.[v] ?? v;
  if (topicId && def.scopes.includes('topic')) {
    const v = (await scopeRows(app, scopeId(topicId)))[key];
    if (v != null) return { value: norm(v), source: 'topic' };
  }
  const g = (await scopeRows(app, 'g'))[key];
  if (g != null) return { value: norm(g), source: 'global' };
  const e = envValue(app.env, def);
  if (e != null) return { value: e, source: 'env' };
  return { value: def.def, source: 'default' };
}

export async function getSetting(app, key, topicId) {
  return (await resolveSetting(app, key, topicId)).value;
}

/**
 * Whether to forward (keep "Forwarded from …") instead of copy. Messages that
 * originate from any admin account, the admin group or the bot itself (a guest
 * message forwarded from another topic) are always copied, so forwarding never
 * reveals the admins or shows "Forwarded from <bot>". An admin with forward privacy shows up
 * as `hidden_user` with only a name, so names are matched too: the sender's
 * own name plus every admin name seen in the group (rememberAdmin).
 */
export async function keepForwardSource(app, msg, topicId) {
  const origin = msg.forward_origin;
  if (!origin) return false;
  const mode = await getSetting(app, 'forward_source', topicId);
  if (mode === 'none') return false;
  if (mode === 'channel') return origin.type === 'channel';
  // The bot itself: e.g. an admin forwarding a guest's message (a bot copy) from one topic to another.
  if (origin.type === 'user' && (app.cfg.adminIds.has(origin.sender_user?.id) || origin.sender_user?.id === app.cfg.botId)) return false;
  if (origin.type === 'chat' && origin.sender_chat?.id === app.cfg.groupId) return false;
  if (origin.type === 'hidden_user') return !(await isAdminName(app, origin.sender_user_name, msg.from));
  return true;
}

// ---------------------------------------------------------------- panel
//
// Everything is driven from one message in General, edited in place:
//   global panel  --[💬 会话设置]-->  session list (paged)  --[pick]-->  session panel
// so per-conversation settings never require typing inside a guest's topic.

const SOURCE_LABEL = { topic: '本会话', global: '全局', env: '.env', default: '默认' };
const optionLabel = (def, v) => def.options.find(([x]) => x === v)?.[1] ?? v;
const PAGE = 20;

async function sessionName(app, topicId) {
  const user = await app.db.getUserByTopic(topicId);
  if (user) return `👤 ${user.name || user.user_id}`;
  const list = await app.db.getList(topicId);
  return list ? `📤 ${list.name}` : `话题 ${topicId}`;
}

async function panel(app, topicId) {
  const scope = topicId ? 'topic' : 'global';
  const isList = topicId ? Boolean(await app.db.getList(topicId)) : false;
  const defs = SETTINGS.filter((s) => s.scopes.includes(scope) && (!topicId || !s.sessions || (s.sessions === 'list') === isList));
  const lines = topicId
    ? [`⚙️ 会话设置：${esc(await sessionName(app, topicId))}`, '未单独设置的项跟随全局。', '']
    : ['⚙️ 全局设置', '单个会话的设置在下方「💬 会话设置」里。', ''];
  const rows = [];
  for (const def of defs) {
    const { value, source } = await resolveSetting(app, def.key, topicId);
    const own = topicId ? source === 'topic' : source === 'global';
    lines.push(`<b>${def.label}</b>：${optionLabel(def, value)}（${SOURCE_LABEL[source]}）\n<i>${def.help}</i>`);
    rows.push([{
      text: `${def.label}：${optionLabel(def, value)}${own ? '' : `（${topicId ? '跟随全局' : SOURCE_LABEL[source]}）`} ▸`,
      callback_data: `st:${topicId || 'g'}:${def.key}`,
    }]);
  }
  if (isList) {
    rows.push([{ text: '🗑 移除名单', callback_data: `st:x:${topicId}` }]);
  }
  rows.push(topicId
    ? [{ text: '◂ 会话列表', callback_data: 'st:s:0' }, { text: '◂ 全局设置', callback_data: 'st:h' }]
    : [{ text: '💬 会话设置 ▸', callback_data: 'st:s:0' }]);
  lines.push('', '点按钮切换，立即生效。');
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

/** Lists (first page) and guests, most recently active first; ⚙️ marks sessions with overrides. */
async function sessionList(app, page) {
  const { db } = app;
  const custom = await db.topicsWithSettings();
  const lists = page === 0 ? await db.allLists() : [];
  const guests = await db.recentGuests(PAGE + 1, page * PAGE);
  const more = guests.length > PAGE;
  const mark = (id) => (custom.has(id) ? '⚙️ ' : '');
  const items = [
    ...lists.map((l) => ({ text: `${mark(l.topic_id)}📤 ${l.name}（${l.n}人）`, id: l.topic_id })),
    ...guests.slice(0, PAGE).map((g) => ({ text: `${mark(g.topic_id)}👤 ${g.name || g.user_id}`, id: g.topic_id })),
  ];
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2).map((x) => ({ text: x.text.slice(0, 40), callback_data: `st:o:${x.id}` })));
  }
  const nav = [{ text: '◂ 全局设置', callback_data: 'st:h' }];
  if (page > 0) nav.push({ text: '◂ 上一页', callback_data: `st:s:${page - 1}` });
  if (more) nav.push({ text: '下一页 ▸', callback_data: `st:s:${page + 1}` });
  rows.push(nav);
  return {
    text: items.length ? '💬 选择一个会话进行单独设置（⚙️ = 已有单独设置，按最近联系排序）' : '💬 还没有会话。',
    reply_markup: { inline_keyboard: rows },
  };
}

/** `/settings` opens the global panel in General (from a topic, it opens that session's panel there). */
export async function showSettings(app, msg, topicId) {
  const p = { chat_id: app.cfg.groupId, ...(await panel(app, topicId)) };
  if (topicId) p.message_thread_id = topicId;
  return app.tg.call('sendMessage', p);
}

export async function handleSettingsCallback(app, cq) {
  const { cfg, db, tg } = app;
  const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  if (cq.message?.chat?.id !== cfg.groupId || !cfg.adminIds.has(cq.from.id)) return answer('无权限');
  const show = async (view) => {
    await tg.call('editMessageText', { chat_id: cfg.groupId, message_id: cq.message.message_id, ...view })
      .catch((err) => { if (!(err instanceof TgError && err.notModified)) console.error('settings edit failed', err.message); });
  };

  if (cq.data === 'st:h') { await answer(); return show(await panel(app, 0)); }
  let m = /^st:s:(\d+)$/.exec(cq.data);
  if (m) { await answer(); return show(await sessionList(app, Number(m[1]))); }
  m = /^st:o:(\d+)$/.exec(cq.data);
  if (m) { await answer(); return show(await panel(app, Number(m[1]))); }
  // Unregister a list topic (e.g. one deleted in Telegram, which bots are not told about).
  m = /^st:x:(\d+)$/.exec(cq.data);
  if (m) {
    const list = await db.getList(Number(m[1]));
    if (!list) { await answer('名单已不存在'); return show(await sessionList(app, 0)); }
    await answer();
    return show({
      text: `移除名单「📤 ${list.name}」？\n它的成员和单独设置会一起清除；话题本身不会被删除，之后在里面发的消息不再群发。`,
      reply_markup: { inline_keyboard: [[
        { text: '确认移除', callback_data: `st:X:${m[1]}` },
        { text: '取消', callback_data: `st:o:${m[1]}` },
      ]] },
    });
  }
  m = /^st:X:(\d+)$/.exec(cq.data);
  if (m) {
    await db.deleteList(Number(m[1]));
    await answer('已移除');
    return show(await sessionList(app, 0));
  }

  // Cycle one setting: [inherit, ...options] — inherit removes the row.
  m = /^st:(g|\d+):([a-z_]+)$/.exec(cq.data);
  const def = m && BY_KEY[m[2]];
  if (!def) return answer();
  const topicId = m[1] === 'g' ? 0 : Number(m[1]);
  if (!def.scopes.includes(topicId ? 'topic' : 'global')) return answer();
  const scope = scopeId(topicId);
  const stored = (await db.getSettings(scope))[def.key] ?? null;
  const current = stored == null ? null : (def.legacy?.[stored] ?? stored);
  const cycle = [null, ...def.options.map(([v]) => v)];
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
  if (next == null) await db.deleteSetting(scope, def.key);
  else await db.setSetting(scope, def.key, next);
  app.settingsCache = null; // re-read for the re-render
  const { value } = await resolveSetting(app, def.key, topicId);
  await answer(`${def.label}：${optionLabel(def, value)}`);
  return show(await panel(app, topicId));
}
