// Webhook health check, run by the existing 5-minute cron (no extra Cron slot).
// When Telegram can't deliver updates to the Worker (errors, a backlog), say so
// in General once, and once more when it recovers. State lives in settings
// scope 'h' so an ongoing problem is reported a single time.

const SCOPE = 'h';
const RECENT_ERROR_S = 600; // an error in the last 10 minutes counts as "now"
const BACKLOG = 30; // pending updates that mean the Worker isn't keeping up

export async function checkWebhook(app) {
  const info = await app.tg.call('getWebhookInfo', {});
  const now = Math.floor(Date.now() / 1000);
  const errAt = info.last_error_date ?? 0;
  const pending = info.pending_update_count ?? 0;
  const bad = (errAt && now - errAt < RECENT_ERROR_S) || pending >= BACKLOG;

  const state = await app.db.getSettings(SCOPE);
  const alerting = state.alerting === '1';
  if (bad && (!alerting || state.err_at !== String(errAt))) {
    const why = info.last_error_message ? `：${info.last_error_message}` : '';
    await app.notify(`⚠️ Telegram 投递消息到 bot 出错${why}（积压 ${pending} 条）。修好之前访客的消息可能延迟或丢失。`);
    await app.db.setSetting(SCOPE, 'alerting', '1');
    await app.db.setSetting(SCOPE, 'err_at', String(errAt));
  } else if (!bad && alerting) {
    await app.notify('✅ Telegram 投递已恢复正常。');
    await app.db.setSetting(SCOPE, 'alerting', '0');
  }
}
