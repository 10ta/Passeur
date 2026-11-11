// What counts as a message worth relaying. Telegram also posts service
// messages into chats (auto-delete timer changed, a pin, a new chat
// background, a topic edit…); copyMessage always rejects those, so they are
// dropped silently on both sides instead of producing "cannot be delivered".
//
// A whitelist of content fields (Bot API `Message`), not a blacklist of
// service fields: Telegram keeps adding service types, and an unknown one must
// never be relayed or reported to the guest.
//
// Some content here still can't be copied (paid media, invoices, giveaways,
// games); those reach copyMessage and get the normal "unsupported" reply,
// because the guest did send something and should know it didn't go through.

const CONTENT_KEYS = [
  'text', 'photo', 'video', 'animation', 'audio', 'document', 'voice', 'video_note', 'sticker',
  'location', 'venue', 'contact', 'poll', 'dice', 'story', 'checklist',
  'paid_media', 'invoice', 'game', 'giveaway', 'giveaway_winners',
];

export const isRelayable = (msg) => CONTENT_KEYS.some((k) => msg[k] != null);
