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

There is no linter; match the existing style.

## Repository map

- `src/index.js` — fetch (webhook auth + routing) and scheduled (cron) handlers; `createApp` wires config, Telegram, D1.
- `src/guest.js` — everything in a guest's private chat: `/start`, captcha, rate limit, relay to topic, edit sync.
- `src/admin.js` — the admin forum group: relay topic → guest, commands, `/check`, delivery error reports.
- `src/relay.js` — `sendSingle`, `sendAlbumItem`, topic create/recover, `syncEdit`. Shared by both directions via a `route` object.
- `src/lists.js` — list topics: `/newlist`, member panel (`lm:<topic>:<user>` callbacks, saved on each tap), `fanOut` to members.
- `src/settings.js` — `SETTINGS` registry, `getSetting(app, key, topicId?)`, `keepForwardSource`, `/settings` panel (`st:<g|topic>:<key>` callbacks).
- `src/db.js` — the only place with SQL. `src/telegram.js` — Bot API client and `TgError` classifiers.
- `migrations/` — D1 schema; add the next numbered file (`0004_*.sql`), never edit an applied migration.
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
- Topics are recipient lists. Guest topics (`users.topic_id`) are strictly 1:1 and keep reply threading, edit sync and inbound relay; list topics (`lists`, `list_members`) are outbound-only fan-out without `msg_map` rows. Never add members to a guest topic: the guest's replies would land elsewhere.
- List budget: `MAX_MEMBERS = 45` × 1 call + 1 reaction/report ≤ 50 (a test asserts it). Raising it needs batching via the cron.
- `bufferAlbum(app, fromChat, msg, { group, single }, onError)` is the shared album buffer; `sendAlbumItem` (one route) and `fanOut` (many members) both use it.
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
- The fake D1 batch returns `results` only for statements starting with `SELECT`, like D1.
- Forwarding keeps "Forwarded from" (default `forward_source = all`); `keepForwardSource` must keep copying messages whose origin is an admin account or the admin group, or the admins are revealed.
- Legacy `FORWARD_CHANNEL_POSTS`: only `1` means anything (= `channel`); `0` was the old template default and must stay ignored, or it would override the new `all` default in existing `.env` files.

## Current focus

- 2026-11-10: first version. Open items: confirm the three "assumed" rows in README → Limitations on the live bot.
