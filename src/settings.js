// Runtime settings: one registry, four layers.
//   topic row (t:<id>) -> global row (g) -> .env -> built-in default
// The /settings panel writes the first two layers; "默认" deletes the row so
// the next layer shows through. To add a setting, add one entry to SETTINGS
// and read it with getSetting(app, key, topicId?).

import { TgError } from './telegram.js';

export const SETTINGS = [
  {
    key: 'forward_source', label: '转发来源', env: 'FORWARD_SOURCE', def: 'all', scopes: ['global', 'topic'],
    options: [['all', '保留'], ['channel', '仅频道'], ['none', '隐藏']],
    help: '转发来的消息发给访客时，是否保留“转发自…”。来源是管理员自己或本群时总是隐藏。',
  },
  {
    key: 'verify', label: '新访客验证', env: 'VERIFY', def: '1', scopes: ['global'],
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
  if (def.key === 'verify') return FLAG_TRUE.includes(raw) ? '1' : FLAG_FALSE.includes(raw) ? '0' : null;
  if (def.options.some(([v]) => v === raw)) return raw;
  return /^\d+$/.test(raw) && def.key !== 'forward_source' ? raw : null; // e.g. RATE_LIMIT_PER_MIN=15
}

const scopeId = (topicId) => (topicId ? `t:${topicId}` : 'g');

/** Rows of one scope, read once per request. */
function scopeRows(app, scope) {
  app.settingsCache ??= new Map();
  if (!app.settingsCache.has(scope)) app.settingsCache.set(scope, app.db.getSettings(scope));
  return app.settingsCache.get(scope);
}

/** Effective value and where it came from: 'topic' | 'global' | 'env' | 'default'. */
export async function resolveSetting(app, key, topicId) {
  const def = BY_KEY[key];
  if (topicId && def.scopes.includes('topic')) {
    const v = (await scopeRows(app, scopeId(topicId)))[key];
    if (v != null) return { value: v, source: 'topic' };
  }
  const g = (await scopeRows(app, 'g'))[key];
  if (g != null) return { value: g, source: 'global' };
  const e = envValue(app.env, def);
  if (e != null) return { value: e, source: 'env' };
  return { value: def.def, source: 'default' };
}

export async function getSetting(app, key, topicId) {
  return (await resolveSetting(app, key, topicId)).value;
}

/**
 * Whether to forward (keep "Forwarded from …") instead of copy. Messages that
 * originate from an admin account or the admin group are always copied, so
 * forwarding never reveals the admins.
 */
export async function keepForwardSource(app, msg, topicId) {
  const origin = msg.forward_origin;
  if (!origin) return false;
  const mode = await getSetting(app, 'forward_source', topicId);
  if (mode === 'none') return false;
  if (mode === 'channel') return origin.type === 'channel';
  if (origin.type === 'user' && app.cfg.adminIds.has(origin.sender_user?.id)) return false;
  if (origin.type === 'chat' && origin.sender_chat?.id === app.cfg.groupId) return false;
  return true;
}

// ---------------------------------------------------------------- panel

const SOURCE_LABEL = { topic: '本话题', global: '面板', env: '.env', default: '默认' };
const optionLabel = (def, v) => def.options.find(([x]) => x === v)?.[1] ?? v;

async function panel(app, topicId) {
  const scope = topicId ? 'topic' : 'global';
  const defs = SETTINGS.filter((s) => s.scopes.includes(scope));
  const lines = [topicId ? '⚙️ 本话题设置（未单独设置的项跟随全局）' : '⚙️ 全局设置（在话题里发 /settings 可单独设置该话题）', ''];
  const rows = [];
  for (const def of defs) {
    const { value, source } = await resolveSetting(app, def.key, topicId);
    const own = topicId ? source === 'topic' : source === 'global';
    lines.push(`<b>${def.label}</b>：${optionLabel(def, value)}（${SOURCE_LABEL[source]}）\n<i>${def.help}</i>`);
    rows.push([{
      text: `${def.label}：${own ? optionLabel(def, value) : topicId ? '跟随全局' : '默认'} ▸`,
      callback_data: `st:${topicId || 'g'}:${def.key}`,
    }]);
  }
  lines.push('', '点按钮切换，立即生效。');
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

/** `/settings`: global panel in General, topic panel inside a topic. */
export async function showSettings(app, msg, topicId) {
  const p = { chat_id: app.cfg.groupId, ...(await panel(app, topicId)) };
  if (topicId) p.message_thread_id = topicId;
  return app.tg.call('sendMessage', p);
}

/** Cycles one setting: [inherit, ...options] — inherit removes the row. */
export async function handleSettingsCallback(app, cq) {
  const { cfg, db, tg } = app;
  const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const m = /^st:(g|\d+):([a-z_]+)$/.exec(cq.data);
  const def = m && BY_KEY[m[2]];
  if (!def || cq.message?.chat?.id !== cfg.groupId || !cfg.adminIds.has(cq.from.id)) return answer('无权限');
  const topicId = m[1] === 'g' ? 0 : Number(m[1]);
  if (!def.scopes.includes(topicId ? 'topic' : 'global')) return answer();

  const scope = scopeId(topicId);
  const current = (await db.getSettings(scope))[def.key] ?? null;
  const cycle = [null, ...def.options.map(([v]) => v)];
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
  if (next == null) await db.deleteSetting(scope, def.key);
  else await db.setSetting(scope, def.key, next);
  app.settingsCache = null; // re-read for the re-render

  const { value } = await resolveSetting(app, def.key, topicId);
  await answer(`${def.label}：${optionLabel(def, value)}`);
  await tg.call('editMessageText', { chat_id: cfg.groupId, message_id: cq.message.message_id, ...(await panel(app, topicId)) })
    .catch((err) => { if (!(err instanceof TgError && err.notModified)) console.error('settings edit failed', err.message); });
}
