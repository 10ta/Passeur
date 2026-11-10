#!/usr/bin/env node
// Small helpers for update.sh, so the shell script never has to parse .env
// or JSON itself.
//   node scripts/env.mjs get KEY            -> prints value ('' if unset)
//   printf %s VALUE | node scripts/env.mjs set KEY
//   node scripts/env.mjs secrets-json       -> JSON for `wrangler secret bulk` (empty -> null = delete)
//   node scripts/env.mjs webhook-json       -> body for setWebhook
//   node scripts/env.mjs commands-json      -> body for setMyCommands (admin group scope)
//   node scripts/env.mjs d1-id NAME < list  -> database uuid from `wrangler d1 list --json`
//   node scripts/env.mjs field PATH < json  -> value at dotted PATH of a JSON document

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

const ENV_FILE = '.env';
const SECRET_KEYS = [
  'BOT_TOKEN', 'WEBHOOK_SECRET', 'ADMIN_IDS', 'GROUP_ID',
  'VERIFY', 'RATE_LIMIT_PER_MIN', 'FORWARD_SOURCE', 'RECEIPTS', 'TOPIC_STATUS', 'FORWARD_CHANNEL_POSTS', 'RETENTION_DAYS', 'WELCOME_TEXT',
];

const unquote = (v) => {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
};

function readEnv() {
  if (!existsSync(ENV_FILE)) return { lines: [], values: {} };
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const values = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m) values[m[1]] = unquote(m[2]);
  }
  return { lines, values };
}

const readStdin = () => readFileSync(0, 'utf8');

/**
 * Parses JSON from output that may start with banners such as
 * "▲ [WARNING] Proxy environment variables detected": tries every line that
 * begins with [ or { until the rest of the text parses.
 */
function parseLooseJson(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // banner line that happens to start with "[" — keep looking
    }
  }
  throw new Error('no JSON in input');
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'get':
    process.stdout.write(readEnv().values[arg] ?? '');
    break;
  case 'set': {
    const value = readStdin().replace(/\r?\n$/, '');
    if (/[\r\n]/.test(value)) throw new Error(`${arg}: value must be a single line (use \\n)`);
    const { lines } = readEnv();
    const entry = `${arg}=${value}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${arg}\\s*=`).test(l));
    if (i >= 0) lines[i] = entry;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, entry);
    writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
    chmodSync(ENV_FILE, 0o600); // mode above only applies when the file is created
    break;
  }
  case 'secrets-json': {
    const { values } = readEnv();
    const out = {};
    for (const k of SECRET_KEYS) out[k] = values[k] ? values[k] : null;
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case 'webhook-json': {
    const { values } = readEnv();
    process.stdout.write(JSON.stringify({
      url: `${values.WORKER_URL.replace(/\/+$/, '')}/webhook`,
      secret_token: values.WEBHOOK_SECRET,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      max_connections: 20,
    }));
    break;
  }
  case 'commands-json': {
    const { values } = readEnv();
    const commands = [
      ['help', '命令说明'], ['info', '用户信息（话题内）'], ['block', '拉黑（话题内）'], ['unblock', '解除拉黑（话题内）'],
      ['settings', '设置面板（全局 + 会话设置）'], ['newlist', '新建名单话题（发给多人）'], ['list', '名单面板（名单话题内）'], ['broadcast', '广播（General 里回复一条消息）'], ['cancel', '取消广播'], ['forget', '删除访客记录（话题内）'], ['blocked', '拉黑列表'],
      ['stats', '统计'], ['check', '检查配置'], ['id', '显示聊天 ID'],
    ].map(([command, description]) => ({ command, description }));
    process.stdout.write(JSON.stringify({ scope: { type: 'chat', chat_id: Number(values.GROUP_ID) }, commands }));
    break;
  }
  case 'd1-id': {
    const list = parseLooseJson(readStdin());
    process.stdout.write(list.find((d) => d.name === arg)?.uuid ?? '');
    break;
  }
  case 'field': {
    let v = parseLooseJson(readStdin());
    for (const k of arg.split('.')) v = v?.[k];
    process.stdout.write(v == null ? '' : String(v));
    break;
  }
  default:
    console.error('usage: env.mjs get|set|secrets-json|d1-id|field');
    process.exit(2);
}
