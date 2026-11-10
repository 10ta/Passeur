// Broadcast in small batches: the Workers Free plan allows 50 external
// subrequests per invocation, so one batch sends to at most BATCH users and
// the cron trigger (every 5 minutes) continues where it stopped.

import { TgError } from './telegram.js';

export const BATCH = 40;
const LEASE_SECONDS = 120;

export async function runBroadcastBatch(app) {
  const { db, tg, cfg } = app;
  const job = await db.activeBroadcast();
  if (!job || !(await db.leaseBroadcast(job.id, LEASE_SECONDS))) return;

  const targets = await db.broadcastTargets(job.cursor, BATCH);
  let { cursor, sent, failed } = job;
  let throttled = false;
  for (const t of targets) {
    try {
      await tg.call('copyMessage', { chat_id: t.user_id, from_chat_id: cfg.groupId, message_id: job.src_msg_id });
      sent++;
    } catch (err) {
      if (err instanceof TgError && err.code === 429) { throttled = true; break; } // retry this user next run
      failed++;
    }
    cursor = t.user_id;
  }
  const done = !throttled && targets.length < BATCH;
  await db.finishBatch(job.id, cursor, sent, failed, done);
  if (done) await app.notify(`📣 广播完成：成功 ${sent}，失败 ${failed}（多为已屏蔽 bot 的用户）。`);
}
