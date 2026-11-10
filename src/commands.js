/** Returns { name, args } when the message starts with a bot command, else null. */
export function parseCommand(msg) {
  const text = msg?.text;
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const first = msg.entities?.[0];
  if (!first || first.type !== 'bot_command' || first.offset !== 0) return null;
  const raw = text.slice(1, first.length);
  const name = raw.split('@')[0].toLowerCase();
  return { name, args: text.slice(first.length).trim() };
}
