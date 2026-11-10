#!/usr/bin/env bash
# Install or update Passeur. Idempotent: run it after every `git pull` / patch.
# Prompts only for settings that are still empty in .env.
set -euo pipefail
cd "$(dirname "$0")"

NAME=passeur # Worker + D1 database name; keep in sync with wrangler.example.toml

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m%s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m%s\n' "$*" >&2; exit 1; }
envget() { node scripts/env.mjs get "$1"; }
envset() { printf '%s' "$2" | node scripts/env.mjs set "$1"; }
wr() { npx --no-install wrangler "$@"; }

# ask KEY "prompt" [required|optional|secret]
ask() {
  local key=$1 msg=$2 mode=${3:-required} val=''
  [ -n "$(envget "$key")" ] && return 0
  if [ ! -t 0 ]; then
    [ "$mode" = optional ] && return 0
    die "$key 为空，且当前不是交互终端：请先填写 .env"
  fi
  while :; do
    if [ "$mode" = secret ]; then read -rsp "$msg: " val; echo; else read -rp "$msg: " val; fi
    if [ -n "$val" ] || [ "$mode" = optional ]; then break; fi
  done
  if [ -n "$val" ]; then envset "$key" "$val"; fi
}

# tg METHOD JSON — the token goes through curl's config on stdin, never argv.
tg() {
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$(envget BOT_TOKEN)" "$1" |
    curl -sS --max-time 20 -K - -H 'content-type: application/json' -d "$2"
}

# ---------------------------------------------------------------- prerequisites
for c in node npm curl; do command -v "$c" >/dev/null || die "缺少 $c"; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' ||
  die "需要 Node.js 22.13+（当前 $(node -v)）"

if [ ! -f .env ]; then
  cp .env.example .env
  say "已创建 .env"
fi
chmod 600 .env # holds the bot token

say "安装依赖"
npm install --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------- Cloudflare auth
cf_auth() {
  local t a
  t=$(envget CLOUDFLARE_API_TOKEN); a=$(envget CLOUDFLARE_ACCOUNT_ID)
  if [ -n "$t" ]; then export CLOUDFLARE_API_TOKEN="$t"; fi
  if [ -n "$a" ]; then export CLOUDFLARE_ACCOUNT_ID="$a"; fi
  wr whoami 2>&1 | grep -q 'You are logged in'
}
if ! cf_auth; then
  warn "未登录 Cloudflare。可以 Ctrl-C 后运行 npx wrangler login，或在下面粘贴 API Token（权限：Workers Scripts:Edit + D1:Edit）"
  ask CLOUDFLARE_API_TOKEN "Cloudflare API Token" secret
  cf_auth || die "Cloudflare 认证失败：检查 token 权限，或在 .env 填 CLOUDFLARE_ACCOUNT_ID"
fi

# ---------------------------------------------------------------- bot settings
ask BOT_TOKEN "BotFather 给的 Bot Token" secret
me=$(tg getMe '{}' || true)
bot_user=$(printf '%s' "$me" | node scripts/env.mjs field result.username) || true
[ -n "$bot_user" ] || die "Bot Token 无效：$me"
say "Bot: @$bot_user"

if [ -z "$(envget WEBHOOK_SECRET)" ]; then
  envset WEBHOOK_SECRET "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
fi
ask ADMIN_IDS "管理员 ID（逗号分隔；不知道就先回车，部署后私聊 bot 发 /id）" optional
ask GROUP_ID "管理群 ID（-100 开头；还没有就先回车）" optional

# A wrong GROUP_ID fails silently at runtime (topics can't be created), so check it here.
# Common mistakes: the "-123…" shown in Telegram Web's address bar (Bot API wants
# "-100123…"), or the old ID of a group from before it became a supergroup.
check_group() {
  local gid res alt title answer
  gid=$(envget GROUP_ID)
  [ -n "$gid" ] || return 0
  [[ $gid =~ ^-?[0-9]+$ ]] || die "GROUP_ID 不是数字：$gid"
  res=$(tg getChat "{\"chat_id\":$gid}" || true)
  if printf '%s' "$res" | grep -q '"ok":true'; then
    printf '%s' "$res" | grep -q '"is_forum":true' || warn "群 $gid 还没开启话题（Topics），bot 无法建话题"
    return 0
  fi
  alt=$(printf '%s' "$res" | node scripts/env.mjs field parameters.migrate_to_chat_id 2>/dev/null || true)
  if [ -z "$alt" ] && [[ $gid != -100* ]]; then alt="-100${gid#-}"; fi
  if [ -n "$alt" ]; then
    res=$(tg getChat "{\"chat_id\":$alt}" || true)
    if printf '%s' "$res" | grep -q '"ok":true'; then
      title=$(printf '%s' "$res" | node scripts/env.mjs field result.title)
      if [ -t 0 ]; then
        read -rp "GROUP_ID=$gid 找不到；$alt 是群「$title」。改用它？[Y/n] " answer
        if [ "$answer" != n ] && [ "$answer" != N ]; then envset GROUP_ID "$alt"; say "GROUP_ID 已改为 $alt"; return 0; fi
      fi
      die "GROUP_ID=$gid 找不到；应为 $alt（群「$title」）。改好 .env 后重新运行"
    fi
  fi
  die "GROUP_ID=$gid 无效：$res
   在管理群里发 /id 查看正确的 ID（bot 必须已在群里），填进 .env 后重新运行"
}
check_group

# ---------------------------------------------------------------- D1 + wrangler.toml
db_id=''
if [ -f wrangler.toml ]; then
  db_id=$(sed -n 's/^database_id = "\([0-9a-f-]\{36\}\)"$/\1/p' wrangler.toml)
fi
if [ -z "$db_id" ]; then
  db_id=$(wr d1 list --json 2>/dev/null | node scripts/env.mjs d1-id "$NAME") || db_id=''
fi
if [ -z "$db_id" ]; then
  say "创建 D1 数据库 $NAME（西欧，靠近 Telegram 服务器）"
  wr d1 create "$NAME" --location weur
  db_id=$(wr d1 list --json 2>/dev/null | node scripts/env.mjs d1-id "$NAME")
  [ -n "$db_id" ] || die "创建 D1 后未找到 $NAME"
fi
# Regenerated every run so template changes (crons etc.) take effect.
sed "s/__D1_DATABASE_ID__/$db_id/" wrangler.example.toml > wrangler.toml

say "应用数据库迁移"
CI=1 wr d1 migrations apply "$NAME" --remote </dev/null

# ---------------------------------------------------------------- deploy
say "部署 Worker"
deploy_out=$(wr deploy 2>&1) || { printf '%s\n' "$deploy_out"; die "部署失败"; }
printf '%s\n' "$deploy_out" | grep -vE '^\s*$' | tail -n 8
url=$(printf '%s\n' "$deploy_out" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1 || true)
if [ -n "$url" ] && [ -z "$(envget WORKER_URL)" ]; then envset WORKER_URL "$url"; fi
ask WORKER_URL "Worker 地址（https://…）"

say "同步 Worker secrets"
node scripts/env.mjs secrets-json | wr secret bulk >/dev/null

# ---------------------------------------------------------------- Telegram webhook
say "设置 webhook"
res=$(tg setWebhook "$(node scripts/env.mjs webhook-json)" || true)
printf '%s' "$res" | grep -q '"ok":true' || die "setWebhook 失败：$res"

tg setMyCommands '{"commands":[{"command":"start","description":"开始 / Start"}]}' >/dev/null || true
group=$(envget GROUP_ID)
if [ -n "$group" ]; then
  res=$(tg setMyCommands "$(node scripts/env.mjs commands-json)" || true)
  printf '%s' "$res" | grep -q '"ok":true' || warn "设置群命令菜单失败（不影响使用）：$res"
fi

info=$(tg getWebhookInfo '{}' || echo '{}')
pending=$(printf '%s' "$info" | node scripts/env.mjs field result.pending_update_count)
last_err=$(printf '%s' "$info" | node scripts/env.mjs field result.last_error_message)
say "完成：webhook 待处理 ${pending:-0} 条${last_err:+，最近错误：$last_err}"

# ---------------------------------------------------------------- next steps
if [ -z "$(envget ADMIN_IDS)" ]; then
  warn "下一步：用号1、号2 分别私聊 @$bot_user 发 /id，把 ID 填进 .env 的 ADMIN_IDS，再运行 ./update.sh"
elif [ -z "$group" ]; then
  warn "下一步：建超级群并开启 Topics → 把 @$bot_user 设为管理员（勾选「管理话题」）→ 号1、号2 入群（如是管理员须关闭「保持匿名」）→ 在群里发 /id，把 ID 填进 .env 的 GROUP_ID，再运行 ./update.sh"
else
  say "在管理群 General 里发 /check 确认配置"
fi
