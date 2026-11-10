// Minimal Telegram Bot API client. No automatic retries: most calls send
// messages and are not idempotent; a timeout may still have been delivered.

export class TgError extends Error {
  constructor(method, code, description, parameters) {
    super(`${method}: ${code} ${description}`);
    this.method = method;
    this.code = code;
    this.description = String(description ?? '');
    this.parameters = parameters ?? {};
  }
  /** User blocked the bot, deleted their account, or never started it. */
  get recipientGone() {
    return this.code === 403 || /chat not found|user is deactivated/i.test(this.description);
  }
  get threadGone() {
    return /message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(this.description);
  }
  get topicClosed() {
    return /TOPIC_CLOSED/i.test(this.description);
  }
  get notModified() {
    return /message is not modified/i.test(this.description);
  }
}

const TIMEOUT_MS = 10_000;

export function createTelegram(token, fetchImpl = fetch) {
  const base = `https://api.telegram.org/bot${token}/`;
  async function call(method, params = {}) {
    let res;
    try {
      res = await fetchImpl(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Never include the URL: it contains the bot token.
      throw new TgError(method, 0, `network: ${err?.name ?? 'error'}`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new TgError(method, res.status, 'invalid JSON response');
    }
    if (!data.ok) throw new TgError(method, data.error_code ?? res.status, data.description, data.parameters);
    return data.result;
  }
  return { call };
}
