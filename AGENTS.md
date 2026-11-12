# AGENTS.md

## Project overview

- Passeur: two-way Telegram private-chat relay bot; one forum topic per guest, several admin accounts. Human docs: [README.md](README.md).
- Type: Telegram bot (C) on serverless (B). Runs on: Cloudflare Workers (Free plan budget) + D1.
- Stack: plain JavaScript ES modules, no runtime dependencies. Dev: wrangler 4, Node 22.13+ (`node:test`, `node:sqlite`).

## Commands

| Task | Command |
|---|---|
| Install deps | `npm install` |
| Test | `npm test` |
| Single test | `node --test --test-name-pattern="album" test/bot.test.js` |
| Build (bundle, no deploy) | `npm run build` (output: `.wrangler/dry-run/`) |
| Deploy / update | `./update.sh` (interactive only when `.env` has empty required keys) |
| Remove | `./uninstall.sh` |
| Logs | `npx wrangler tail passeur` |

There is no linter; match the existing style. Deeper design notes and measured costs: [docs/how-it-works.md](docs/how-it-works.md).

## Repository map

- `src/index.js` — fetch (webhook auth + routing) and scheduled (cron) handlers; `createApp` wires config, Telegram, D1.
- `src/guest.js` — everything in a guest's private chat: `/start`, captcha, rate limit, relay to topic, edit sync.
- `src/admin.js` — the admin forum group: relay topic → guest, commands, `/check`, delivery error reports.
- `src/relay.js` — `sendSingle`, `sendAlbumItem`, topic create/recover, `syncEdit`. Shared by both directions via a `route` object.
- `src/lists.js` — list topics: `/newlist`, member panel (`lm:<topic>:<user>` callbacks, saved on each tap), `fanOut` to members.
- `src/mirror.js` — mirrors of list messages in recipients' topics: `mirrorDelivered` after a fan-out, `fillPending` before relaying a guest message; `list_pending` holds what is not mirrored yet (cleared on fill, `/forget`, and after 7 days).
- `src/settings.js` — `SETTINGS` registry, `getSetting(app, key, topicId?)`, `keepForwardSource`, `/settings` panel, driven from one General message: `st:h` global, `st:s:<page>` session list, `st:o:<topic>` session panel, `st:<g|topic>:<key>` cycle.
- `src/status.js` — ❗ waiting icon: `markWaiting` after a guest message, `markAnswered` via the route's `onSent` hook; `users.waiting`; icon id cached in settings scope `i`.
- `src/health.js` — `checkWebhook` in the 5-minute cron; alert state in settings scope `h`.
- `src/forget.js` — `/forget` confirm flow (`fg:<topic>:r|t|x`), `db.forgetUser`.
- `src/content.js` — `isRelayable(msg)`: whitelist of content fields; everything else is a service message and is dropped silently (guest DMs and the admin group).
- `src/db.js` — the only place with SQL. `src/telegram.js` — Bot API client and `TgError` classifiers.
- `migrations/` — D1 schema; add the next numbered file (`0008_*.sql`), never edit an applied migration.
- `scripts/env.mjs` — `.env` read/write and JSON bodies for `update.sh`.
- `test/helpers.js` — fake D1 over `node:sqlite` (loads `migrations/`), fake Telegram with `failNext()`.
- To change who may operate the bot, start in `src/admin.js` (`handleGroupMessage`) and `src/guest.js` (admin DM branch).

## Conventions

- ES modules, 2-space indent, single quotes, semicolons, trailing commas.
- User-facing strings to guests are bilingual (中文 / English) in `src/text.js`; admin-group strings are Chinese.
- Messages sent with `parse_mode: 'HTML'` must pass dynamic text through `esc()`.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`); author `10ta <84114181+10ta@users.noreply.github.com>`.
- Changes are delivered as a single `git format-patch` file; the owner applies it with `git am -3 *.patch && rm *.patch && git push && ./update.sh`.

## Architecture & invariants

- The webhook returns 200 even on failure. Telegram retries would duplicate sends; report failures via `app.notify()` or a reply in the topic instead.
- Never auto-retry `sendMessage` / `copyMessage`: a timeout may already have been delivered. The only retry is after a topic problem (`threadGone` / `topicClosed`), once.
- `msg_map.dir`: `0` = guest → topic (`guest_msg_id` original, `topic_msg_id` copy); `1` = topic → guest (`topic_msg_id` original, `guest_msg_id` copy). Edit sync only follows the original → copy direction.
- Topic creation is claimed by setting `users.topic_id = -user_id`; other requests poll. Keep `claimTopic` / `resetTopic` conditional updates.
- Albums: `markAlbumSent` must happen before `takeAlbumItems`, and taking is a single D1 batch (one transaction). This is what makes each item go out exactly once.
- Free plan: ≤ 50 external subrequests and 10 ms CPU per invocation. Broadcast `BATCH = 40` leaves room for the other calls; long waits go in `waitUntil` (≤ 30 s).
- Topics are recipient lists. Guest topics (`users.topic_id`) are strictly 1:1 and keep reply threading, edit sync and inbound relay; list topics (`lists`, `list_members`) are outbound-only fan-out; the only `msg_map` rows they create pair a guest's copy with its mirror in that guest's topic (dir 1). Never add members to a guest topic: the guest's replies would land elsewhere.
- List budget: `MAX_MEMBERS = 24` × (1 delivery + 1 mirror) + 1 failure report ≤ 50 (tests assert it, and that an oversized legacy list still delivers to everyone). Deliveries always come before mirrors.
- `bufferAlbum(app, fromChat, msg, { group, single }, onError)` is the shared album buffer; `sendAlbumItem` (one route) and `fanOut` (many members) both use it.
- Success is silent everywhere. Failures are reported in the topic (`reportDelivery` in `admin.js`, `deliverAll` in `lists.js`) unless the `receipts` setting is `off`. `users.receipt_msg_id` / `receipt_seen` (migration 0004) belong to the withdrawn 👌/👀 marks and are unused; leave them.
- Telegram sends no update when a topic is deleted. List topics are retired explicitly (`st:x` → `st:X` → `db.deleteList`), which never deletes the Telegram topic. A `forum_topic_edited` with a name on a list topic updates `lists.name`.
- Only messages with a content field are relayed (`isRelayable`). Service messages (auto-delete timer, pins, backgrounds, topic edits, future types) never reach `copyMessage` and never produce a guest-facing error. Uncopyable content (paid media, invoices, giveaways, games) does reach it and gets the normal "unsupported" reply. Keep it a whitelist; new content types go into `CONTENT_KEYS`.
- A mirror is a silent `forwardMessage` of the admin's list message (header "Forwarded from <admin>"), never a bare copy: guest messages in a topic are bot copies, so a copy would look like the guest. Forwarded originals (`list_pending.fwd`) get a `📤 群发 · <list>` label line first and cost 2 calls; albums are one label line. A mirror is neither an answer nor a guest message for the status icon. A 429 while mirroring stops mirroring only (never reported as a delivery failure).
- Internal notes: in any topic, text or caption starting with `//` is never sent (`isInternalNote`, checked before guest and list routing). Notes and failed deliveries do not count as an answer for the status icon.
- Source: first `/start <payload>` only (`users.source`, payload `[A-Za-z0-9_-]{1,64}`); shown in topic name, card, `/info`.
- `/forget` clears users, msg_map, list_members and the topic's settings in one batch; deleting the Telegram topic is a separate explicit choice.
- Settings scopes in the `settings` table: `g` global, `t:<topic>` session, `a` admin names, `i` icon cache, `h` health-check state.
- Every per-message query must hit a primary key or index (check with `EXPLAIN QUERY PLAN` in a test).

## Do not

- Do not commit `.env`, `wrangler.toml` (holds the account's D1 ID) or `.wrangler/`.
- Do not log Telegram request URLs: they contain the bot token.
- Do not authorize by group membership; only `cfg.adminIds` (sole exception: `/id` and `/check` in a group that is not `GROUP_ID`, which only reveal that group's own ID). Messages with `sender_chat` equal to the group are anonymous admins and must be refused.
- Do not put the bot token in command-line arguments in shell scripts (`tg()` in `update.sh` passes it via `curl -K -`).
- Do not add a second Cron Trigger: free accounts have 5 in total, shared by all their Workers.

## Config & secrets

- Read from Worker secrets, pushed from `.env` by `update.sh` (`scripts/env.mjs secrets-json`; empty values become `null`, which deletes the secret). Parsed in `src/config.js`. Full table: [README → Configuration](README.md#-configuration).
- Structural config (`BOT_TOKEN`, `ADMIN_IDS`, `GROUP_ID`, `WEBHOOK_SECRET`, `WELCOME_TEXT`) is parsed in `loadConfig()`.
- Runtime settings resolve topic row → global row (`settings` table) → `.env` → default via `getSetting`. Add one: an entry in `SETTINGS` (key, label, env key, default, scopes, options, help), its `.env` key in `.env.example` and `SECRET_KEYS`, a row in both READMEs' settings table. Use `scopes: ['global', 'topic']` for per-conversation settings.
- `getSetting` caches each scope per request (`app.settingsCache`); clear it after writing.
- Tests need no secrets.

## Deployment & environments

- Production: Worker `passeur` on `*.workers.dev` (or `WORKER_URL`), D1 `passeur` (location hint `weur`). Deployed by the owner running `./update.sh`; no CI.
- Rollback: `npx wrangler rollback` restores the previous Worker version; schema changes are forward-only, so make migrations additive.

## Before you finish

- [ ] `npm test` passes.
- [ ] `npm run build` prints `Total Upload`.
- [ ] `shellcheck update.sh uninstall.sh` is clean if you touched them.
- [ ] Docs synced: if you changed commands, config keys, deployment or user-visible behavior, update **both** `README.md` and `README.zh-CN.md`, and this file.

## Gotchas

- In forum topics every message has `reply_to_message` pointing at the topic root; treat `reply_to_message.message_id === message_thread_id` as "not a reply".
- `wrangler … --json` output can be preceded by a `▲ [WARNING] …` banner that starts with `[`; parse it with `scripts/env.mjs` (`parseLooseJson`), not `JSON.parse`.
- Bot API group IDs are `-100…`; Telegram Web shows the same group as `-…` without `100`. `check_group` in `update.sh` validates `GROUP_ID` with `getChat` and suggests the fix; keep it before deploy.
- `ensureTopic` can fail (wrong `GROUP_ID`, lost Manage Topics): it must stay inside the guest's error handling so the guest is told, since the admin notice goes to the same unreachable group.
- `node -e … "$value"` treats a negative number like `-100123` as a node option; pass values through files or `scripts/env.mjs`.
- Tests: Telegram JSON never contains undefined keys, so `isRelayable` checks values, not `in`; test album items must carry `photo`/`video` like real ones.
- The fake D1 batch returns `results` only for statements starting with `SELECT`, like D1.
- Forwarding keeps "Forwarded from" (default `forward_source = all`); `keepForwardSource` must keep copying messages whose origin is any admin account or the admin group, or the admins are revealed.
- Admins with forward privacy appear as `hidden_user` (name only). `rememberAdmin` stores each admin's display name (settings scope `a`, written only on change) from group messages, DMs to the bot and `/check`; `isAdminName` matches NFC-normalized names against them and the sender, and looks up still-unknown admins with `getChatMember`.
- Settings can carry `legacy` value maps (e.g. `receipts`: `1`→`fail`, `0`→`off` from the 👌/👀 version); they apply to `.env` and to stored rows.
- Legacy `FORWARD_CHANNEL_POSTS`: only `1` means anything (= `channel`); `0` was the old template default and must stay ignored, or it would override the new `all` default in existing `.env` files.

## Current focus

- 2026-11-10: first version. Forwarded-origin row confirmed on the live bot; two "assumed" rows remain in README → Limitations.
