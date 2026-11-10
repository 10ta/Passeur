// Parses Worker env (all values come from `wrangler secret bulk`, see update.sh).

const DEFAULTS = {
  VERIFY: '1',
  RATE_LIMIT_PER_MIN: '20',
  FORWARD_CHANNEL_POSTS: '0',
  RETENTION_DAYS: '90',
  WELCOME_TEXT: '你好！直接发消息给我，我会转达给对方。\nHi! Just send your message here and it will be delivered.',
};

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function flag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
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
    verify: flag(get('VERIFY')),
    rateLimitPerMin: Math.max(0, int(get('RATE_LIMIT_PER_MIN'), 20)),
    forwardChannelPosts: flag(get('FORWARD_CHANNEL_POSTS')),
    retentionDays: Math.max(1, int(get('RETENTION_DAYS'), 90)),
    welcomeText: String(get('WELCOME_TEXT')).replace(/\\n/g, '\n'),
  };
}
