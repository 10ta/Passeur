// Parses the structural Worker env (all values come from `wrangler secret bulk`,
// see update.sh). Runtime-adjustable settings (verify, rate limit, forward
// source, retention) live in src/settings.js, which also reads their .env keys.

const DEFAULTS = {
  WELCOME_TEXT: '你好！直接发消息给我，我会转达给对方。\nHi! Just send your message here and it will be delivered.',
};

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env) {
  const get = (k) => (env[k] === undefined || env[k] === '' ? DEFAULTS[k] : env[k]);
  const adminIds = new Set(
    String(env.ADMIN_IDS ?? '')
      .split(/[\s,]+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );
  const groupId = int(env.GROUP_ID, 0);
  return {
    token: String(env.BOT_TOKEN ?? ''),
    webhookSecret: String(env.WEBHOOK_SECRET ?? ''),
    adminIds,
    groupId, // 0 = setup mode: only /id works
    welcomeText: String(get('WELCOME_TEXT')).replace(/\\n/g, '\n'),
  };
}
