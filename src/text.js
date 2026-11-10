export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || (user?.username ? `@${user.username}` : `user ${user?.id ?? '?'}`);
}

/** Forum topic names are limited to 128 characters. */
export function topicName(name, id) {
  const suffix = ` · ${id}`;
  const room = 128 - suffix.length;
  const base = [...name].length > room ? [...name].slice(0, room - 1).join('') + '…' : name;
  return base + suffix;
}

export function userCard(from, row) {
  const lines = [
    `👤 <a href="tg://user?id=${from.id}">${esc(displayName(from))}</a>`,
    `ID: <code>${from.id}</code>`,
  ];
  if (from.username) lines.push(`Username: @${esc(from.username)}`);
  if (from.language_code) lines.push(`Lang: ${esc(from.language_code)}`);
  if (from.is_premium) lines.push('Premium: ✅');
  if (row) {
    lines.push(`Status: ${row.blocked ? '⛔ blocked' : '✅ active'}${row.verified ? '' : ' · unverified'}`);
    lines.push(`First seen: ${new Date(row.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  }
  return lines.join('\n');
}

export const T = {
  verifyPrompt: (a, b) => `🔒 请先完成验证 / Please verify first:\n\n${a} + ${b} = ?`,
  verifyOk: '✅ 验证通过，你的消息已转达。/ Verified, your message was delivered.',
  verifyOkNoPending: '✅ 验证通过，现在可以发消息了。/ Verified, you can send messages now.',
  verifyLocked: (min) => `⏳ 错误次数过多，请 ${min} 分钟后再试。/ Too many attempts, try again in ${min} min.`,
  rateLimited: '⏳ 发送太快了，请稍后再发。/ Slow down, please try again in a minute.',
  sendFailed: '⚠️ 发送失败，请稍后重试。/ Delivery failed, please try again later.',
  unsupported: '⚠️ 这种消息无法转达。/ This type of message cannot be delivered.',
  adminDm: '你是管理员：请在管理群对应用户的话题里回复。\nYou are an admin: reply inside the guest\'s topic in the admin group.',
};

export const HELP = `<b>话题内命令（仅管理员）</b>
/info — 用户信息
/block — 拉黑此用户
/unblock — 解除拉黑

<b>设置</b>
/settings — 设置面板：全局设置，以及「💬 会话设置」里每个会话的单独设置

<b>名单话题（一条消息发给多人）</b>
/newlist 名字 — 新建名单话题，在里面发的消息会发给名单上所有人
/list — 在名单话题里调出勾选面板（最多 45 人）

<b>General 里的命令</b>
/broadcast — 回复一条消息发送此命令，广播给所有用户
/cancel — 取消进行中的广播
/blocked — 拉黑列表
/stats — 统计
/check — 检查群与管理员配置
/id — 显示当前聊天 ID

话题里不以 / 开头的消息都会转达给该用户。`;
